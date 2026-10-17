// Pausas view: screen time per app (today / last 7 days). Fetches only while it is on screen.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { EyecareBridge } from "./bridge";
import { appName, dayKey, dayTotal, fmtDur, lastDays, topApps, type Days } from "./logic";

const TOP = 6;

export function buildView(ctx: ViewContext): ViewHost {
  const body = h("div", { class: "stack scroll eyecare-view" });
  body.style.padding = "14px 12px 14px 84px";
  const el = view(card(null, body));
  let busy = false;

  const bars = (rows: { label: string; secs: number }[], max: number) =>
    rows.map((r) => {
      const fill = h("i");
      fill.style.width = `${max ? Math.max(2, (r.secs / max) * 100) : 0}%`;
      return h("div", { class: "eyecare-row" },
        h("span", { class: "eyecare-name", text: r.label }),
        h("div", { class: "eyecare-bar" }, fill),
        h("span", { class: "eyecare-dur", text: fmtDur(r.secs) }));
    });

  const draw = (days: Days) => {
    clear(body);
    const now = new Date(), today = dayKey(now), week = lastDays(now, 7);
    const apps = topApps(days, [today], TOP);
    const weekDays = week.map((k) => ({ label: new Date(`${k}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""), secs: dayTotal(days[k]) }));
    body.append(
      h("div", { class: "title", text: `Hoje: ${fmtDur(dayTotal(days[today]))} de tela` }),
      apps.length ? h("div", { class: "eyecare-list" }, ...bars(apps.map((a) => ({ label: appName(a.exe), secs: a.secs })), apps[0].secs))
        : h("div", { class: "sub", text: "Nada contado ainda hoje." }),
      h("div", { class: "sub", text: "Últimos 7 dias" }),
      h("div", { class: "eyecare-list" }, ...bars(weekDays, Math.max(...weekDays.map((d) => d.secs)))),
      h("div", { class: "actions" }, h("div", { class: "grow" }),
        h("button", { class: "link-btn text-link", text: "Apagar dados", onclick: () => void EyecareBridge.clear().then(load) })),
    );
    ctx.onResize();
  };
  const load = async () => {
    if (busy) return;
    busy = true;
    try { draw(await EyecareBridge.usage()); } finally { busy = false; }
  };
  let shown = false;
  return {
    el,
    // Nothing is fetched while the tab is hidden; one fetch each time it comes up.
    sync() {
      const on = ctx.api.island.view() === "eyecare";
      if (on && !shown) void load();
      shown = on;
    },
  };
}
