// Pill badge helper: pure, so it tests under node.

import type { Pill } from "./state";

export type PillBadge = "alert" | "done" | "error";

/** Sets a pill badge; true only when it changed (a repeat redraws nothing). */
export function applyBadge(pills: Pill[], id: string, badge: PillBadge | null): boolean {
  const t = pills.find((x) => x.id === id);
  if (!t || (t.badge ?? null) === badge) return false;
  t.badge = badge;
  return true;
}
