// The Sistema view. It samples every 2 s only while it is the open view of a visible island (api.interval whenVisible,
// re-armed by sync, ended the first tick after the view is left); leaving it releases the Rust-side sampler.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { SysmonBridge, type LhmInfo, type Port, type Reading, type Snapshot } from "./bridge";
import { bytes, pct, rate, showOf } from "./logic";

interface Cfg { sysmonShow: unknown; sysmonLhm: boolean; sysmonLhmPort: number; sysmonSpeedUrl: string }
const msg = (e: unknown) => String(e).replace(/^Error:\s*/, "");

export function buildSysmonView(ctx: ViewContext, onTemp: (c: number | null) => void): ViewHost {
  const api = ctx.api;
  const metrics = h("div", { class: "sysmon-grid" });
  const procs = h("div", { class: "sysmon-procs" });
  const lhmBox = h("div", { class: "sysmon-lhm" });
  const tools = h("div", { class: "sysmon-tools" });
  const body = h("div", { class: "sysmon-body" }, metrics, procs, lhmBox, tools);
  const el = view(card(null, body));
  let tick: (() => void) | null = null;
  let n = 0;
  let busy = false;
  let readings: Reading[] | null = null;
  let lhmInfo: LhmInfo | null = null;
  let lhmMsg = "";
  let last: Snapshot | null = null;

  const cell = (label: string, value: string, sub = "", pctValue?: number | null) =>
    h("div", { class: "sysmon-cell" },
      h("span", { class: "sysmon-k", text: label }), h("b", { class: "sysmon-v", text: value }), sub && h("span", { class: "sysmon-sub", text: sub }),
      pctValue != null && h("i", { class: "sysmon-bar" }, h("i", { style: `width:${Math.max(1, Math.min(100, pctValue))}%` })));

  const cpuTemps = () => (readings ?? []).filter((r) => /cpu|core|package|tctl|tdie/i.test(`${r.hardware} ${r.label}`));
  const hottest = (): number | null => {
    const all = [...cpuTemps().map((r) => r.celsius), ...(last?.driveTemps ?? []).map((d) => d.celsius), ...((readings ?? []).map((r) => r.celsius))];
    return all.length ? Math.max(...all) : null;
  };

  const drawMetrics = () => {
    const s = last;
    const show = showOf(api.settings<Cfg>().sysmonShow);
    clear(metrics);
    if (!s) return;
    if (show.cpu) metrics.append(cell("CPU", pct(s.cpu), "", s.cpu));
    if (show.ram) metrics.append(cell("Memória", pct(s.ramTotal ? (s.ramUsed * 100) / s.ramTotal : null), `${bytes(s.ramUsed)} de ${bytes(s.ramTotal)}`, s.ramTotal ? (s.ramUsed * 100) / s.ramTotal : null));
    if (show.gpu) metrics.append(cell("GPU", pct(s.gpu), s.gpuMem != null ? `${bytes(s.gpuMem)} de VRAM` : "", s.gpu));
    if (show.disk) {
      metrics.append(cell("Disco", pct(s.diskBusy), "atividade", s.diskBusy));
      for (const d of s.disks) metrics.append(cell(d.name, `${bytes(d.total - d.free)}`, `${bytes(d.free)} livres de ${bytes(d.total)}`, ((d.total - d.free) * 100) / d.total));
    }
    if (show.net) metrics.append(cell("Rede", `↓ ${rate(s.netDown)}`, `↑ ${rate(s.netUp)}`));
    if (show.temp) {
      for (const d of s.driveTemps) metrics.append(cell(d.name, `${Math.round(d.celsius)} °C`, "temperatura"));
      for (const r of cpuTemps().slice(0, 3)) metrics.append(cell(r.label, `${Math.round(r.celsius)} °C`, r.hardware));
      if (!s.driveTemps.length && !cpuTemps().length) metrics.append(cell("Temperaturas", "–", "indisponível sem o LibreHardwareMonitor (opcional, abaixo)"));
    }
  };

  const killBtn = (p: { pid: number; name: string }) => {
    const b = h("button", { class: "link-btn text-link", text: "Encerrar" }) as HTMLButtonElement;
    let armed = false;
    b.addEventListener("click", () => {
      if (!armed) { armed = true; b.textContent = "Confirmar?"; api.timeout(() => { armed = false; b.textContent = "Encerrar"; }, 3000); return; }
      b.disabled = true;
      SysmonBridge.kill(p.pid, p.name).then(() => api.island.note(`${p.name} encerrado`), (e) => { b.disabled = false; api.island.error(msg(e)); });
    });
    return b;
  };

  const drawProcs = () => {
    clear(procs);
    const s = last;
    if (!s || !showOf(api.settings<Cfg>().sysmonShow).top || !s.byCpu || !s.byMem) return;
    const list = (title: string, items: typeof s.byCpu, val: (p: { cpu: number; mem: number }) => string) =>
      h("div", { class: "sysmon-list" }, h("span", { class: "sysmon-k", text: title }),
        ...items!.slice(0, 5).map((p) => h("div", { class: "sysmon-proc" }, h("span", { class: "sysmon-name", text: p.name }), h("span", { class: "sysmon-sub", text: val(p) }), killBtn(p))));
    procs.append(list("Mais CPU", s.byCpu, (p) => pct(p.cpu)), list("Mais memória", s.byMem, (p) => bytes(p.mem)));
  };

  const drawLhm = () => {
    clear(lhmBox);
    const c = api.settings<Cfg>();
    const i = lhmInfo;
    lhmBox.append(h("span", { class: "sysmon-k", text: "Temperatura da CPU (opcional)" }));
    if (!c.sysmonLhm) {
      lhmBox.append(h("span", { class: "sysmon-sub", text: "Usa o LibreHardwareMonitor, de terceiros. Ative em Ajustes > Sistema." }));
    } else if (readings) {
      lhmBox.append(h("span", { class: "sysmon-sub", text: "Lendo do LibreHardwareMonitor (servidor local)." }));
    } else {
      lhmBox.append(h("span", { class: "sysmon-sub", text: lhmMsg || `Abra o LibreHardwareMonitor com o servidor web ligado (porta ${c.sysmonLhmPort}).` }));
      if (i && !i.installed) {
        lhmBox.append(
          h("span", { class: "sysmon-sub", text: `Baixar: LibreHardwareMonitor v${i.version}, ${bytes(i.size)}, de ${new URL(i.url).host}. Confere SHA-256 fixo antes de extrair. Salva em ${i.dir.replace(/\\LibreHardwareMonitor-[^\\]*$/, "")}.` }),
          h("button", { class: "btn secondary", text: "Baixar LibreHardwareMonitor", onclick: (ev: Event) => {
            const b = ev.currentTarget as HTMLButtonElement;
            b.disabled = true; lhmMsg = "Baixando…"; drawLhm();
            SysmonBridge.lhmInstall().then((r) => { lhmInfo = r; lhmMsg = "Instalado. Abra-o e ligue Options > Remote Web Server."; drawLhm(); }, (e) => { lhmMsg = msg(e); drawLhm(); });
          } }));
      } else if (i?.installed) {
        lhmBox.append(h("button", { class: "btn secondary", text: "Abrir LibreHardwareMonitor", onclick: () => void SysmonBridge.lhmOpen().catch((e) => api.island.error(msg(e))) }),
          h("span", { class: "sysmon-sub", text: "O Windows pede administrador por conta dele. Ligue Options > Remote Web Server." }));
      }
    }
  };

  // Tools: built once (inputs keep focus across samples).
  const out = h("div", { class: "sysmon-sub" });
  const url = h("input", { class: "island-field", type: "text", placeholder: "https://… (arquivo grande de sua escolha)", spellcheck: "false", value: api.settings<Cfg>().sysmonSpeedUrl }) as HTMLInputElement;
  const target = h("span", { class: "sysmon-sub" });
  const go = h("button", { class: "btn secondary", text: "Testar velocidade" }) as HTMLButtonElement;
  url.addEventListener("input", () => {
    if (!url.value.trim()) { target.textContent = ""; return; }
    SysmonBridge.endpoint(url.value).then((host) => (target.textContent = `Vai contatar: ${host}`), (e) => (target.textContent = msg(e)));
  });
  url.addEventListener("change", () => void api.saveSettings({ sysmonSpeedUrl: url.value.trim() }));
  go.addEventListener("click", () => {
    go.disabled = true; out.textContent = "Baixando…";
    SysmonBridge.speedtest(url.value).then(
      (r) => { out.textContent = `${r.mbps.toFixed(1).replace(".", ",")} Mbps (${bytes(r.bytes)} em ${(r.ms / 1000).toFixed(1).replace(".", ",")} s, de ${r.host})`; },
      (e) => { out.textContent = msg(e); },
    ).finally(() => (go.disabled = false));
  });
  const ports = h("div", { class: "sysmon-list" });
  const portsBtn = h("button", { class: "btn secondary", text: "Portas abertas" });
  portsBtn.addEventListener("click", () => {
    SysmonBridge.ports().then((l: Port[]) => {
      clear(ports);
      for (const p of l.slice(0, 12)) ports.append(h("div", { class: "sysmon-proc" }, h("span", { class: "sysmon-name", text: `:${p.port}` }), h("span", { class: "sysmon-sub", text: `${p.process || "?"} (${p.pid})${p.exposed ? " · aberta à rede" : ""}` })));
      if (!l.length) ports.append(h("span", { class: "sysmon-sub", text: "Nenhuma porta TCP em escuta." }));
    }, (e) => api.island.error(msg(e)));
  });
  tools.append(
    h("div", { class: "sysmon-row" }, portsBtn, go, url), target,
    h("span", { class: "sysmon-sub", text: "O teste de velocidade só roda ao clicar e baixa de um único endereço https que você escolher." }), out, ports);

  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const c = api.settings<Cfg>();
      const show = showOf(c.sysmonShow);
      last = await SysmonBridge.sample(show.top, show.temp);
      n++;
      if (c.sysmonLhm && (n === 1 || n % 3 === 0)) {
        readings = await SysmonBridge.lhmRead(c.sysmonLhmPort).catch(() => null);
        if (!readings) lhmMsg = "";
      }
      onTemp(hottest());
      drawMetrics(); drawProcs(); drawLhm();
    } catch (e) {
      api.island.error(msg(e));
    } finally {
      busy = false;
    }
  };

  const open = () => api.island.view() === "sysmon" && api.island.mode() === "expanded";
  const stop = () => { tick?.(); tick = null; n = 0; last = null; readings = null; void SysmonBridge.release().catch(() => {}); };
  const arm = () => {
    if (tick) return;
    void SysmonBridge.lhmInfo().then((i) => { lhmInfo = i; if (last) drawLhm(); }, () => {});
    void sample();
    tick = api.interval(() => { if (!open()) return stop(); void sample(); }, 2000, { whenVisible: true });
  };
  return { el, sync() { if (open()) arm(); } };
}
