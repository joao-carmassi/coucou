// Pill badge helper: pure, so it tests under node.

import type { Pill } from "./state";

export type PillBadge = "alert" | "done" | "error";

/** Old badge names, accepted for one version (approval -> alert, finished -> done). */
export type LegacyBadgeName = "approval" | "finished";
export const BADGE_ALIAS: Readonly<Record<string, PillBadge>> = { approval: "alert", finished: "done" };

export function badgeName(b: string | null | undefined): PillBadge | null {
  if (!b) return null;
  return BADGE_ALIAS[b] ?? (b as PillBadge);
}

/** Sets a pill badge; true only when it changed (a repeat redraws nothing). */
export function applyBadge(pills: Pill[], id: string, badge: PillBadge | null): boolean {
  const t = pills.find((x) => x.id === id);
  if (!t || (t.badge ?? null) === badge) return false;
  t.badge = badge;
  return true;
}
