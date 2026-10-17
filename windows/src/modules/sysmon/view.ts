// The Sistema view. It samples every 2 s only while it is the open view of a visible island (api.interval whenVisible,
// re-armed by sync, ended the first tick after the view is left); leaving it releases the Rust-side sampler.
// The DOM is built once and updated in place, so bars glide (CSS transitions, idle while hidden) and nothing jumps.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { pinButton } from "../../kit/pin";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { SysmonBridge, type LhmInfo, type Reading, type Snapshot } from "./bridge";
import { bytes, clampInt, fitHeight, heat, pct, rate, showOf, spark } from "./logic";

interface Cfg { sysmonShow: unknown; sysmonLhm: boolean; sysmonLhmPort: number; sysmonTempMax: number }
const msg = (e: unknown) => String(e).replace(/^Error:\s*/, "");
const HISTORY = 30;
const BLANK = " ";

const ns = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** A metric tile: label, big value, sparkline of the last samples, one line of detail. */
function tile(label: string, tone: string) {
  const value = h("b", { class: "sysmon-v", text: "–" });
  const sub = h("span", { class: "sysmon-sub", text: BLANK });
  const area = ns("path", { class: "sysmon-area" });
  const line = ns("path", { class: "sysmon-line" });
  const graph = ns("svg", { class: "sysmon-spark", viewBox: "0 0 100 24", preserveAspectRatio: "none", "aria-hidden": "true" });
  graph.append(ns("path", { class: "sysmon-mid", d: "M0,12.5H100" }), area, line);
  const el = h("div", { class: `sysmon-tile ${tone}` }, h("div", { class: "sysmon-tile-head" }, h("span", { class: "sysmon-k", text: label }), value), graph, sub);
  const hist: number[] = [];
  const plot = () => { const p = spark(hist, HISTORY); area.setAttribute("d", p.area); line.setAttribute("d", p.line); };
  return {
    el,
    reset() { hist.length = 0; value.textContent = "–"; sub.textContent = BLANK; el.classList.remove("off"); plot(); },
    set(v: number | null, detail: string, off = false) {
      el.classList.toggle("off", off);
      value.textContent = off ? "–" : pct(v);
      sub.textContent = detail || BLANK;
      if (v != null) { hist.push(v); if (hist.length > HISTORY) hist.shift(); }
      plot();
    },
  };
}

const bar = () => { const fill = h("i"); return { el: h("i", { class: "sysmon-bar" }, fill), fill }; };
const setBar = (b: { el: HTMLElement; fill: HTMLElement }, v: number) => {
  const p = Math.max(0, Math.min(100, v));
  b.fill.style.width = `${p}%`;
  b.el.classList.toggle("warm", p >= 75 && p < 90);
  b.el.classList.toggle("high", p >= 90);
};
const section = (title: string, ...aside: Node[]) =>
  h("div", { class: "sysmon-sec" }, h("div", { class: "sysmon-sec-head" }, h("span", { class: "sysmon-k", text: title }), ...aside));

export function buildSysmonView(ctx: ViewContext, onTemp: (c: number | null) => void, onSnap: (s: Snapshot) => void): ViewHost {
  const api = ctx.api;
  const cpu = tile("CPU", "sysmon-cpu"), ram = tile("Memória", "sysmon-ram"), gpu = tile("GPU", "sysmon-gpu");
  const tiles = h("div", { class: "sysmon-tiles" }, cpu.el, ram.el, gpu.el);

  const diskBusy = h("span", { class: "sysmon-num", text: "–" });
  const drives = h("div", { class: "sysmon-list" });
  const disk = section("Disco", h("span", { class: "sysmon-aside" }, "atividade ", diskBusy));
  disk.append(drives);
  const down = h("span", { class: "sysmon-num wide", text: "–" }), up = h("span", { class: "sysmon-num wide", text: "–" });
  const netRow = (arrow: string, cls: string, label: string, v: HTMLElement) =>
    h("div", { class: "sysmon-row" }, h("span", { class: `sysmon-arrow ${cls}`, text: arrow }), h("span", { class: "sysmon-name", text: label }), v);
  const net = section("Rede");
  net.append(h("div", { class: "sysmon-list" }, netRow("↓", "dn", "Download", down), netRow("↑", "up", "Upload", up)));
  const io = h("div", { class: "sysmon-io" }, disk, net);

  const chips = h("div", { class: "sysmon-chips" });
  const lhmBox = h("div", { class: "sysmon-note" });
  const temps = section("Temperaturas");
  temps.append(chips, lhmBox);

  const body = h("div", { class: "sysmon-body" }, tiles, io, temps);
  const el = view(card(null, body));
  const pin = pinButton(api, "usage");
  pin.el.classList.add("sysmon-pin");
  el.append(pin.el);
  let tick: (() => void) | null = null;
  let n = 0;
  let busy = false;
  let readings: Reading[] | null = null;
  let lhmInfo: LhmInfo | null = null;
  let lhmMsg = "";
  let last: Snapshot | null = null;
  let fitted = fitHeight(showOf(null), { drives: 1, chipLines: 1, note: false });
  // Height follows what is shown; asked again (onResize) only when it changes.
  const refit = () => {
    const next = fitHeight(showOf(api.settings<Cfg>().sysmonShow), { drives: last?.disks.length ?? 1, chipLines: Math.ceil(chips.children.length / 4), note: !lhmBox.hidden });
    if (next === fitted) return;
    fitted = next;
    ctx.onResize();
  };
  let driveRows = new Map<string, { bar: ReturnType<typeof bar>; free: HTMLElement }>();

  const cpuTemps = () => (readings ?? []).filter((r) => /cpu|core|package|tctl|tdie/i.test(`${r.hardware} ${r.label}`));
  const hottest = (): number | null => {
    const all = [...(last?.driveTemps ?? []).map((d) => d.celsius), ...(readings ?? []).map((r) => r.celsius)];
    return all.length ? Math.max(...all) : null;
  };

  const drawDrives = (s: Snapshot) => {
    if (s.disks.map((d) => d.name).join("|") !== [...driveRows.keys()].join("|")) {
      clear(drives);
      driveRows = new Map();
      for (const d of s.disks) {
        const b = bar(), free = h("span", { class: "sysmon-num wide" });
        driveRows.set(d.name, { bar: b, free });
        drives.append(h("div", { class: "sysmon-row" }, h("span", { class: "sysmon-name drive", text: d.name }), b.el, free));
      }
    }
    for (const d of s.disks) {
      const r = driveRows.get(d.name)!;
      setBar(r.bar, ((d.total - d.free) * 100) / d.total);
      r.free.textContent = `${bytes(d.free)} livres`;
      r.free.title = `${bytes(d.total - d.free)} usados de ${bytes(d.total)}`;
    }
  };

  const drawTemps = (s: Snapshot) => {
    clear(chips);
    const max = clampInt(api.settings<Cfg>().sysmonTempMax, 40, 120, 85);
    const list = [...cpuTemps().slice(0, 3).map((r) => ({ name: r.label, c: r.celsius })), ...s.driveTemps.map((d) => ({ name: d.name, c: d.celsius }))];
    for (const t of list) {
      chips.append(h("span", { class: `sysmon-chip ${heat(t.c, max)}`, title: t.name }, h("span", { class: "sysmon-chip-name", text: t.name }), h("b", { text: `${Math.round(t.c)} °C` })));
    }
    if (!list.length) chips.append(h("span", { class: "sysmon-sub", text: "Nenhum sensor de temperatura lido." }));
  };

  const draw = () => {
    const s = last;
    const show = showOf(api.settings<Cfg>().sysmonShow);
    cpu.el.hidden = !show.cpu; ram.el.hidden = !show.ram; gpu.el.hidden = !show.gpu;
    tiles.hidden = !show.cpu && !show.ram && !show.gpu;
    disk.hidden = !show.disk; net.hidden = !show.net; io.hidden = !show.disk && !show.net;
    temps.hidden = !show.temp;
    if (!s) { refit(); return; }
    const ramPct = s.ramTotal ? (s.ramUsed * 100) / s.ramTotal : null;
    cpu.set(s.cpu, s.cpu == null ? "medindo…" : "uso total");
    ram.set(ramPct, `${bytes(s.ramUsed)} de ${bytes(s.ramTotal)}`);
    const noGpu = n > 1 && s.gpu == null && s.gpuMem == null;
    gpu.set(s.gpu, noGpu ? "sem GPU" : s.gpuMem != null ? `${bytes(s.gpuMem)} de VRAM` : "", noGpu);
    diskBusy.textContent = pct(s.diskBusy);
    drawDrives(s);
    down.textContent = rate(s.netDown); up.textContent = rate(s.netUp);
    drawTemps(s);
  };
  const redraw = () => { draw(); drawLhm(); refit(); };

  const drawLhm = () => {
    clear(lhmBox);
    lhmBox.hidden = readings != null;
    if (readings) return;
    const c = api.settings<Cfg>();
    const i = lhmInfo;
    const text = (t: string) => h("span", { class: "sysmon-sub", text: t });
    lhmBox.append(h("span", { class: "sysmon-note-title", text: "Temperatura da CPU requer o LibreHardwareMonitor" }));
    if (!c.sysmonLhm) {
      lhmBox.append(text("Programa de terceiros, opcional. Ative em Ajustes > Sistema."));
      return;
    }
    lhmBox.append(text(lhmMsg || `Abra-o com o servidor web ligado (porta ${c.sysmonLhmPort}).`));
    if (i && !i.installed) {
      lhmBox.append(
        text(`Baixar: LibreHardwareMonitor v${i.version}, ${bytes(i.size)}, de ${new URL(i.url).host}. Confere SHA-256 fixo antes de extrair. Salva em ${i.dir.replace(/\\LibreHardwareMonitor-[^\\]*$/, "")}.`),
        h("button", { class: "btn secondary sysmon-btn", text: "Baixar LibreHardwareMonitor", onclick: (ev: Event) => {
          const b = ev.currentTarget as HTMLButtonElement;
          b.disabled = true; lhmMsg = "Baixando…"; drawLhm();
          SysmonBridge.lhmInstall().then((r) => { lhmInfo = r; lhmMsg = "Instalado. Abra-o e ligue Options > Remote Web Server."; drawLhm(); }, (e) => { lhmMsg = msg(e); drawLhm(); });
        } }));
    } else if (i?.installed) {
      lhmBox.append(text("O Windows pede administrador por conta dele. Ligue Options > Remote Web Server."),
        h("button", { class: "btn secondary sysmon-btn", text: "Abrir LibreHardwareMonitor", onclick: () => void SysmonBridge.lhmOpen().catch((e) => api.island.error(msg(e))) }));
    }
  };

  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const c = api.settings<Cfg>();
      last = await SysmonBridge.sample(showOf(c.sysmonShow).temp);
      n++;
      if (c.sysmonLhm && (n === 1 || n % 3 === 0)) {
        readings = await SysmonBridge.lhmRead(c.sysmonLhmPort).catch(() => null);
        if (!readings) lhmMsg = "";
      }
      onTemp(hottest());
      onSnap(last);
      redraw();
    } catch (e) {
      api.island.error(msg(e));
    } finally {
      busy = false;
    }
  };

  const open = () => api.island.view() === "sysmon" && api.island.mode() === "expanded";
  const stop = () => {
    tick?.(); tick = null; n = 0; last = null; readings = null; onTemp(null);
    cpu.reset(); ram.reset(); gpu.reset();
    void SysmonBridge.release().catch(() => {});
  };
  const arm = () => {
    if (tick) return;
    redraw();
    void SysmonBridge.lhmInfo().then((i) => { lhmInfo = i; drawLhm(); }, () => {});
    void sample();
    tick = api.interval(() => { if (!open()) return stop(); void sample(); }, 2000, { whenVisible: true });
  };
  // A hidden island ticks nothing, so the interval cannot notice: release here too.
  api.onVisibility((mode) => { if (mode === "hidden") stop(); });
  // Settings may change while the view is open: refit then too (deferred, as the stored settings replace after listeners).
  api.listen("settings-changed", () => void api.timeout(() => { draw(); refit(); }, 0));
  return { el, get height() { return fitted; }, sync() { pin.sync(); if (open()) arm(); } };
}
