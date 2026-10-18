// How tall the island should be for a card whose content varies (from core/layout.ts at m3-ok).

import { PANEL_H } from "../../core/moduleApi";

const ISLAND_CHROME = 52;
const VIEW_MIN = 160;
/** The air a card that asks something keeps above and below its lines. */
export const CARD_AIR = 22;
/**
 * The least air any card keeps: one that tells something — a turn's end, an
 * error — is as tall as it always was until its lines would come closer to
 * its edges than this.
 */
export const CARD_AIR_MIN = 14;

export function fittedHeight(content: number, air = CARD_AIR): number {
  return Math.min(PANEL_H, Math.max(VIEW_MIN, Math.ceil(content) + ISLAND_CHROME + 2 * air));
}

/**
 * The width a card's lines will have once the island has finished opening, given the island's and the
 * lines' width now (the chrome between them is constant). Undefined when no layout yet or already wide enough.
 */
export function finalWidth(islandW: number, linesW: number, expanded: number): number | undefined {
  if (islandW <= 0 || linesW <= 0) return undefined;
  const next = expanded - (islandW - linesW);
  return next > linesW + 1 ? next : undefined;
}

/** Runs `measure` with `lines` at its final width, restored at once: no paint sees it. */
export function atFinalWidth<T>(lines: HTMLElement, expanded: number, measure: () => T): T {
  const isl = document.getElementById("island");
  const w = isl ? finalWidth(isl.offsetWidth, lines.offsetWidth, expanded) : undefined;
  if (w === undefined) return measure();
  lines.style.width = w + "px";
  try {
    return measure();
  } finally {
    lines.style.width = "";
  }
}
