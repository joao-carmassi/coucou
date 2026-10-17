// The compact island's one status line: highest priority wins. Pure, no timers.

import type { StatusLine } from "./moduleApi";

interface Entry { line: StatusLine; at: number; seq: number }

const lines = new Map<string, Entry>();
let seq = 0;

const same = (a: StatusLine, b: StatusLine) =>
  a.priority === b.priority && a.text === b.text && a.icon === b.icon &&
  a.ttlMs === b.ttlMs && a.urgent === b.urgent && a.view === b.view && a.dim === b.dim && a.overGrid === b.overGrid &&
  a.card?.art === b.card?.art && a.card?.sub === b.card?.sub && a.card?.trail === b.card?.trail && a.card?.dim === b.card?.dim &&
  !a.card === !b.card;

export const Compact = {
  /** True when the line changed. Never notifies State: the caller redraws. */
  set(owner: string, line: StatusLine | null, now = performance.now()): boolean {
    const prev = lines.get(owner);
    if (!line) return lines.delete(owner);
    lines.set(owner, { line, at: now, seq: ++seq });
    return !prev || !same(prev.line, line);
  },

  resolve(otherPills: number, now = performance.now()): StatusLine | null {
    let best: Entry | null = null;
    let bestOwner = "";
    for (const [owner, e] of lines) {
      if (e.line.ttlMs != null && now - e.at > e.line.ttlMs) continue;
      if (otherPills > 0 && !e.line.overGrid) continue;
      // A tie goes to the newest, except that the core's own notice beats a plain status line.
      const tie = best && e.line.priority === best.line.priority;
      if (!best || e.line.priority > best.line.priority ||
          (tie && (owner === "#notice" || (bestOwner !== "#notice" && e.seq > best.seq)))) { best = e; bestOwner = owner; }
    }
    return best?.line ?? null;
  },
};
