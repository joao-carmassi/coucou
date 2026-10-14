// Pill badge helper: pure, so it tests under node.

import type { AgentTask } from "./state";

export type PillBadge = "approval" | "finished" | "error";

/** Sets a task badge; true only when it changed (a repeat redraws nothing). */
export function applyBadge(tasks: AgentTask[], id: string, badge: PillBadge | null): boolean {
  const t = tasks.find((x) => x.id === id);
  if (!t || (t.pillBadge ?? null) === badge) return false;
  t.pillBadge = badge;
  return true;
}
