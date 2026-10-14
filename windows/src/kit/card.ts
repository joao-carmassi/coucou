// The card every view sits on, and the wash colours it takes (CardBackground.washColor).
// API: card(wash | {wash?, cls?}, ...kids), view(...kids) (the `div.view` shell), washRGBA(wash).

import { h } from "./dom";

export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}

/** `card(wash, ...kids)` or `card({wash?, cls?}, ...kids)`: `div.card[.wash][.cls]`, with `--wash` set. */
export function card(o: Wash | { wash?: Wash; cls?: string }, ...children: (Node | string)[]): HTMLElement {
  const { wash = null, cls } = o !== null && typeof o === "object" ? o : { wash: o, cls: undefined };
  const el = h("div", { class: ["card", wash && "wash", cls].filter(Boolean).join(" ") }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

export const view = (...children: (Node | string | null | undefined | false)[]): HTMLElement => h("div", { class: "view" }, ...children);
