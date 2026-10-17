// The Uso do plano view: a head row (title, last read, Atualizar) and one block per agent with a bar per window. Codex
// comes from the local files (kept fresh by the module); Claude only when the network opt-in is on, fetched while this
// view is open (5 min interval) or on "Atualizar". Heights are fixed (logic.ts fitPlan adds them up), nothing animates.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { pinButton } from "../../kit/pin";
import { PANEL_H, type ViewContext, type ViewHost } from "../../core/moduleApi";
import type { AgentUsage, UsageWindow } from "../agents/api";
import { CLAUDE_MS, fitPlan, level, live, resetText, windowLabel } from "./logic";

export interface Ctrl {
  codex(): AgentUsage | null;
  claude(): AgentUsage | null;
  netOn(): boolean;
  /** Reloads Codex's numbers and, with the opt-in on, Claude's (the Rust side still caches 5 min). */
  refresh(force: boolean): Promise<void>;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const OFF = [
  "Ligado, mostra os limites de 5 h e da semana consultando a internet.",
  "Ative em Configurações › Uso do plano (usa o login do Claude Code).",
];

/** One line of a block: label, bar, % used, reset countdown. A window past its reset shows "–" and an empty bar. */
function row(w: UsageWindow, now: number): HTMLElement {
  const on = live(w, now);
  const p = on ? Math.max(0, Math.min(100, w.usedPct as number)) : 0;
  const fill = h("i");
  fill.style.width = `${p > 0 ? Math.max(2, p) : 0}%`;
  const label = windowLabel(w.label);
  return h("div", { class: `planusage-row ${on ? level(p) : "calm"}` },
    h("span", { class: "planusage-name", text: label, title: label }),
    h("span", { class: "planusage-bar" }, fill),
    h("span", { class: "planusage-num", text: on ? `${Math.round(p)}%` : "–" }),
    h("span", { class: "planusage-reset", text: on ? resetText(w.resetsAt, now) : w.usedPct == null ? "sem dado" : "já zerou" }));
}
const note = (text: string, cls = "") => h("div", { class: `planusage-note${cls ? ` ${cls}` : ""}`, text, title: text });

/** A provider block: name and where the numbers come from, then bar rows or quiet note lines. */
function block(name: string, aside: string, lines: HTMLElement[]): HTMLElement {
  return h("div", { class: "planusage-block" },
    h("div", { class: "planusage-block-head" }, h("span", { class: "planusage-agent", text: name }), h("span", { class: "planusage-foot", text: aside })),
    ...lines);
}

/** Lines of a block: its rows (plus the error when it came with old rows), or one note. */
function lines(u: AgentUsage | null, empty: string, now: number): HTMLElement[] {
  if (!u) return [note(empty)];
  if (!u.windows.length) return [u.error ? note(u.error, "err") : note("Nenhum limite informado.")];
  return [...u.windows.map((w) => row(w, now)), ...(u.error ? [note(u.error, "err")] : [])];
}

export function buildPlanusageView(ctx: ViewContext, ctrl: Ctrl, subscribe: (fn: () => void) => void): ViewHost {
  const api = ctx.api;
  const when = h("span", { class: "planusage-foot" });
  const again = h("button", { type: "button", class: "link-btn text-link", text: "Atualizar" });
  again.addEventListener("click", () => {
    again.disabled = true;
    again.textContent = "Atualizando…";
    void ctrl.refresh(true).finally(() => { again.disabled = false; again.textContent = "Atualizar"; });
  });
  const head = h("div", { class: "planusage-head pin-room" }, h("span", { class: "planusage-title", text: "Uso do plano" }), when, again);
  const blocks = h("div", { class: "planusage-blocks" });
  const body = h("div", { class: "stack scroll planusage-body" }, head, blocks);
  const pin = pinButton(api, "plan");
  const el = view(card(null, body, pin.el)); // pin: sibling of the scrolling body, inside the positioned card
  let tick: (() => void) | null = null;
  let fitted = fitPlan([2, 2], PANEL_H).height;

  const draw = () => {
    const now = Date.now();
    const codex = ctrl.codex(), net = ctrl.netOn(), claude = net ? ctrl.claude() : null;
    const codexLines = lines(codex, "Ainda sem leitura das sessões do Codex.", now);
    const claudeLines = net ? lines(claude, "Consultando a Anthropic…", now) : OFF.map((t) => note(t));
    const at = Math.max(codex?.at ?? 0, claude?.at ?? 0);
    when.textContent = at ? `lido às ${clock(at)}` : "";
    clear(blocks);
    blocks.append(
      block("Codex", "arquivos locais", codexLines),
      block("Claude", net ? "internet · não oficial" : "desligado", claudeLines));
    const fit = fitPlan([codexLines.length, claudeLines.length], PANEL_H);
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
