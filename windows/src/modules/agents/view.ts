// The approval card of the Agentes module: who asks, what for, Negar / Permitir.
// Everything that comes from the agent is put in as text, never as markup.
import { card, view } from "../../kit/card";
import { clear, dot, h } from "../../kit/dom";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import type { AgentRow } from "./bridge";

export interface Held { requestId: string; agent: AgentRow; target: string; shownAt: number }
export interface ApprovalSource { held: Held | null; decide(word: "allow" | "deny"): void }

const btn = (label: string, kind: "primary" | "secondary", key: string, onClick: () => void) =>
  h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }), h("span", { class: "kbd", text: key }));

export function buildApproval(src: ApprovalSource, _ctx: ViewContext): ViewHost {
  const who = h("div", { class: "agents-who" });
  const code = h("div", { class: "agents-code" });
  // Built once: rebuilding buttons between a mouse-down and a mouse-up would swallow the click.
  const actions = h("div", { class: "agents-actions" },
    btn("Negar", "secondary", "N", () => src.decide("deny")),
    btn("Permitir", "primary", "Y", () => src.decide("allow")));
  const el = view(card("amber", h("div", { class: "agents-approval" }, who, code, actions)));
  let shown = "";
  return {
    el,
    sync() {
      const held = src.held;
      if ((held?.requestId ?? "") === shown) return;
      shown = held?.requestId ?? "";
      clear(who);
      code.textContent = held?.target ?? "";
      code.title = held?.target ?? "";
      if (held) who.append(dot(held.agent.color, 7), h("b", { text: held.agent.label }), h("span", { text: "precisa de permissão" }));
    },
  };
}
