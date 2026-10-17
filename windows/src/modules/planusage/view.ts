// The Uso do plano view: one block per agent with a bar per window. Codex comes from the local files (kept fresh by the
// module); Claude only when the network opt-in is on, fetched while this view is open (5 min interval) or on "Atualizar".
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { pinButton } from "../../kit/pin";
import { PANEL_H, type ViewContext, type ViewHost } from "../../core/moduleApi";
import type { AgentUsage } from "../agents/api";
import { CLAUDE_MS, agentName, fitPlan, live, resetText } from "./logic";

export interface Ctrl {
  codex(): AgentUsage | null;
  claude(): AgentUsage | null;
  netOn(): boolean;
  /** Reloads Codex's numbers and, with the opt-in on, Claude's (the Rust side still caches 5 min). */
  refresh(force: boolean): Promise<void>;
}

export function buildPlanusageView(ctx: ViewContext, ctrl: Ctrl, subscribe: (fn: () => void) => void): ViewHost {
  const api = ctx.api;
  const body = h("div", { class: "planusage-body" });
  const pin = pinButton(api, "plan");
  const el = view(card(null, body, pin.el));
  let tick: (() => void) | null = null;
  let fitted = fitPlan([0, 0]).height;

  const block = (u: AgentUsage | null, empty: string) => {
    const now = Date.now();
    const box = h("div", {}, h("div", { class: "planusage-k", text: u ? agentName(u.agent) : "" }));
    if (!u || u.error || !u.windows.length) {
      box.append(h("div", { class: "planusage-sub", text: u?.error ?? empty }));
      return box;
    }
    for (const w of u.windows) {
      const on = live(w, now);
      const p = on ? Math.max(0, Math.min(100, w.usedPct as number)) : 0;
      const fill = h("i");
      fill.style.width = `${p}%`;
      box.append(
        h("div", { class: "planusage-row" }, h("span", { text: w.label }),
          h("i", { class: `planusage-bar${p >= 90 ? " high" : p >= 75 ? " warm" : ""}` }, fill),
          h("span", { class: "planusage-num", text: on ? `${Math.round(p)}%` : "–" })),
        h("div", { class: "planusage-sub", text: resetText(w.resetsAt, now) }));
    }
    return box;
  };

  const draw = () => {
    clear(body);
    const codex = ctrl.codex();
    const rows = (u: AgentUsage | null) => (u && !u.error ? u.windows.length : 0);
    const blocks = [rows(codex)];
    body.append(block(codex ? { ...codex, agent: "codex" } : null, "Sem dados do Codex ainda."));
    if (ctrl.netOn()) { body.append(block(ctrl.claude(), "Consultando…")); blocks.push(rows(ctrl.claude())); }
    else body.append(h("div", { class: "planusage-sub", text: "Claude: ative a consulta de rede em Ajustes > Uso do plano." }));
    body.append(h("button", { class: "btn secondary", text: "Atualizar", onclick: () => void ctrl.refresh(true) }));
    const fit = fitPlan(blocks, PANEL_H);
    body.classList.toggle("scroll", fit.scroll);
    if (fit.height !== fitted) { fitted = fit.height; ctx.onResize(); }
  };
  subscribe(() => { if (el.isConnected) draw(); });

  const open = () => api.island.view() === "planusage" && api.island.mode() === "expanded";
  const stop = () => { tick?.(); tick = null; };
  const arm = () => {
    if (tick) return;
    void ctrl.refresh(false);
    tick = api.interval(() => { if (!open()) return stop(); void ctrl.refresh(false); }, CLAUDE_MS, { whenVisible: true });
  };
  api.onVisibility((mode) => { if (mode === "hidden") stop(); });

  return {
    el,
    get height() { return fitted; },
    sync() {
      pin.sync();
      draw();
      if (open()) arm();
    },
  };
}
