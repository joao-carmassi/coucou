// Pausas view, two tabs: "Hoje" (breaks against reminders, last break, streak, screen time per app) and "7 dias"
// (screen time per day with its average, breaks per day, top apps). Fetches only while it is on screen.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { EyecareBridge } from "./bridge";
import {
  NO_BREAKS, appName, breaksOf, dayKey, dayLabel, dayTotal, fitHeight, fmtDur, intervalMin, lastDays, since, streak, topApps, weekdayLabel,
  type Breaks, type Days,
} from "./logic";

type Tab = "today" | "week";
const TOP = 5, WEEK_TOP = 4;
const RULE = "Conta como pausa quando você confirma no lembrete (Fiz a pausa) ou já estava longe do teclado e do mouse há 5 min ou mais.";

const dur = (s: number) => (s >= 60 ? fmtDur(s) : s > 0 ? "< 1 min" : "0 min");
const pct = (v: number, max: number) => (max > 0 ? Math.min(100, Math.round((v / max) * 1000) / 10) : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function bar(fill: number, cls = "") {
  const i = h("i");
  i.style.width = `${fill > 0 ? Math.max(2, fill) : 0}%`;
  return h("span", { class: `eyecare-bar${cls ? ` ${cls}` : ""}` }, i);
}
function tile(k: string, v: string, foot: string | HTMLElement, title?: string) {
  return h("div", { class: "eyecare-tile", title }, h("span", { class: "eyecare-k", text: k }), h("b", { class: "eyecare-v", text: v }),
    typeof foot === "string" ? h("span", { class: "eyecare-foot", text: foot }) : foot);
}
/** Taken against due, as a bar (or a dim line when nothing came due). */
const breakFoot = (due: number, taken: number, none: string) => (due ? bar(pct(taken, due), "ok") : h("span", { class: "eyecare-foot", text: none }));
function section(k: string, aside: string, ...kids: HTMLElement[]) {
  return h("div", { class: "eyecare-sec" },
    h("div", { class: "eyecare-sec-head" }, h("span", { class: "eyecare-k", text: k }), aside && h("span", { class: "eyecare-foot", text: aside })), ...kids);
}
function apps(list: { exe: string; secs: number }[], empty: string) {
  if (!list.length) return h("div", { class: "eyecare-row eyecare-foot", text: empty });
  return h("div", { class: "eyecare-list" }, ...list.map((a) => h("div", { class: "eyecare-row" },
    h("span", { class: "eyecare-name", text: appName(a.exe), title: a.exe }), bar(pct(a.secs, list[0].secs)), h("span", { class: "eyecare-dur", text: dur(a.secs) }))));
}

/** Restarts the one-shot CSS fade-in of the panel (a tab switch only, not a data refresh). */
function fade(el: HTMLElement) {
  el.classList.remove("fade");
  void el.offsetWidth;
  el.classList.add("fade");
}

export function buildView(ctx: ViewContext): ViewHost {
  let tab: Tab = "today";
  let days: Days = {};
  let breaks: Breaks = NO_BREAKS;
  let rows = 0;
  let busy = false;

  const tabBtn = (t: Tab, text: string) => h("button", { type: "button", role: "tab", text, onclick: () => { tab = t; draw(); fade(panel); } });
  const tabs: Record<Tab, HTMLButtonElement> = { today: tabBtn("today", "Hoje"), week: tabBtn("week", "7 dias") };
  const when = h("span", { class: "eyecare-when" });
  // Second click confirms, as in the settings section.
  const wipe = h("button", { type: "button", class: "link-btn text-link", text: "Apagar dados" });
  let armed = false;
  const disarm = () => { armed = false; wipe.textContent = "Apagar dados"; };
  wipe.addEventListener("click", () => {
    if (!armed) { armed = true; wipe.textContent = "Clique de novo para apagar"; return; }
    disarm();
    void EyecareBridge.clear().then(load);
  });
  wipe.addEventListener("blur", disarm);
  const head = h("div", { class: "eyecare-head" }, when, wipe, h("div", { class: "seg eyecare-tabs", role: "tablist", "aria-label": "Período" }, tabs.today, tabs.week));
  const panel = h("div", { class: "eyecare-panel", role: "tabpanel" });
  const body = h("div", { class: "stack scroll eyecare-view" }, head, panel);
  const el = view(card(null, body));

  const today = (now: Date): HTMLElement[] => {
    const k = dayKey(now);
    const list = topApps(days, [k], TOP);
    const count = Object.keys(days[k] ?? {}).length;
    const [due, taken] = breaksOf(breaks, [k]);
    const every = intervalMin(ctx.api.settings<{ eyecareInterval: unknown }>().eyecareInterval);
    const run = streak(breaks, now);
    rows = list.length;
    return [
      h("div", { class: "eyecare-tiles" },
        tile("Tela hoje", dur(dayTotal(days[k])), count ? plural(count, "app", "apps") : "nada contado"),
        tile("Pausas", due ? `${taken} de ${due}` : "–", breakFoot(due, taken, every ? "nenhum lembrete ainda" : "lembretes desligados"), RULE),
        tile("Última pausa", since(breaks.last, now.getTime()) ?? "nenhuma", every ? `lembrete a cada ${every} min` : "lembretes desligados", RULE),
        tile("Sequência", plural(run, "dia", "dias"), "seguidos com pausa")),
      section("Apps hoje", list.length ? "tempo em primeiro plano" : "", apps(list, "Nada contado ainda hoje.")),
    ];
  };

  const week = (now: Date): HTMLElement[] => {
    const keys = lastDays(now, 7), k = dayKey(now);
    const totals = keys.map((d) => dayTotal(days[d]));
    const sum = totals.reduce((a, b) => a + b, 0);
    const active = totals.filter((s) => s > 0).length;
    const avg = active ? sum / active : 0;
    const max = Math.max(...totals);
    const [due, taken] = breaksOf(breaks, keys);
    const plot = h("div", { class: "eyecare-plot" }, ...keys.map((d, i) => {
      const [du, t] = breaksOf(breaks, [d]);
      const col = h("span", { class: d === k ? "eyecare-col today" : "eyecare-col", title: `${dayLabel(d)} · ${dur(totals[i])} de tela · ${du ? `${t} de ${du} pausas` : "sem lembretes"}` }, h("i"));
      (col.firstChild as HTMLElement).style.height = `${totals[i] ? Math.max(3, pct(totals[i], max)) : 0}%`;
      return col;
    }));
    if (avg) plot.append(h("i", { class: "eyecare-avg", style: `bottom:${pct(avg, max)}%`, title: `Média: ${dur(avg)}` }));
    const axis = (cls: string, text: (d: string) => string, title?: string) =>
      h("div", { class: `eyecare-axis ${cls}`, title }, ...keys.map((d) => h("span", { class: d === k ? "today" : undefined, text: text(d) })));
    return [
      h("div", { class: "eyecare-tiles" },
        tile("Tela em 7 dias", dur(sum), `${active} de 7 dias com uso`),
        tile("Média por dia", dur(avg), "nos dias com uso"),
        tile("Pausas", due ? `${taken} de ${due}` : "–", breakFoot(due, taken, "nenhum lembrete"), RULE),
        tile("Maior dia", max ? dur(max) : "–", max ? dayLabel(keys[totals.indexOf(max)]) : "nada contado")),
      h("div", { class: "eyecare-week" },
        h("div", { class: "eyecare-chart" }, plot,
          axis("eyecare-days", weekdayLabel),
          axis("eyecare-brk", (d) => { const [du, t] = breaksOf(breaks, [d]); return du ? `${t}/${du}` : "·"; }, "Pausas / lembretes por dia")),
        section("Apps na semana", "", apps(topApps(days, keys, WEEK_TOP), "Nada contado."))),
    ];
  };

  const draw = (resize = true) => {
    const now = new Date();
    for (const t of Object.keys(tabs) as Tab[]) {
      tabs[t].classList.toggle("on", t === tab);
      tabs[t].setAttribute("aria-selected", String(t === tab));
    }
    const keys = lastDays(now, 7);
    when.textContent = tab === "today" ? dayLabel(keys[6]) : `${dayLabel(keys[0], false)} – ${dayLabel(keys[6], false)}`;
    clear(panel);
    panel.append(...(tab === "today" ? today(now) : week(now)));
    if (resize) ctx.onResize();
  };
  const load = async () => {
    if (busy) return;
    busy = true;
    try {
      [days, breaks] = await Promise.all([EyecareBridge.usage(), EyecareBridge.breaks()]);
      draw();
    } finally { busy = false; }
  };
  draw(false);
  let shown = false;
  // The tiles read the settings (reminder interval): redraw when they change (a tick later, the core stores them after us).
  ctx.api.listen("settings-changed", () => void ctx.api.timeout(() => draw(), 0));
  return {
    el,
    get height() { return fitHeight(tab, rows); },
    // Nothing is fetched while the tab is hidden; one fetch each time it comes up. A folded island keeps the view
    // name, so "up" also needs the island open: reopening on this tab fetches again.
    sync() {
      const on = ctx.api.island.mode() === "expanded" && ctx.api.island.view() === "eyecare";
      if (on && !shown) { draw(); void load(); } // draw now: the fetch is async and the tile must not show a stale interval
      shown = on;
    },
  };
}
