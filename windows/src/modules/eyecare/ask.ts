// The break card: the reminder's text and two buttons ("Fiz a pausa" / "Agora não") to confirm by hand.
import { card, view } from "../../kit/card";
import { clear, h } from "../../kit/dom";
import type { ViewHost } from "../../core/moduleApi";
import { BREAKS, type BreakKind } from "./logic";

export interface AskSource { kind: BreakKind | null; answer(taken: boolean): void }

const btn = (label: string, kind: "primary" | "secondary", onClick: () => void) =>
  h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));

export function buildAsk(src: AskSource): ViewHost {
  const head = h("div", { class: "eyecare-ask-head" });
  // Built once: rebuilding buttons between a mouse-down and a mouse-up would swallow the click.
  const actions = h("div", { class: "eyecare-ask-actions" },
    btn("Agora não", "secondary", () => src.answer(false)),
    btn("Fiz a pausa", "primary", () => src.answer(true)));
  const el = view(card("amber", h("div", { class: "eyecare-ask" }, head, h("span", { text: "Confirme quando fizer a pausa." }), actions)));
  let shown: BreakKind | null = null;
  return {
    el,
    sync() {
      // An answered card keeps its text while the island folds, instead of losing its first line.
      if (!src.kind || src.kind === shown) return;
      shown = src.kind;
      clear(head);
      if (shown) head.append(h("b", { text: BREAKS[shown].text }));
    },
  };
}
