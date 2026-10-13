// How tall the island should be for a card whose content varies (from core/layout.ts at m3-ok).

import { PANEL_H } from "../../core/layout";

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
