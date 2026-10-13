// The compact island's one status line: highest priority wins. Pure, no timers.

import type { StatusLine } from "./moduleApi";

interface Entry { line: StatusLine; at: number; seq: number }

const lines = new Map<string, Entry>();
let seq = 0;

const same = (a: StatusLine, b: StatusLine) =>
  a.priority === b.priority && a.text === b.text && a.icon === b.icon &&
  a.ttlMs === b.ttlMs && a.urgent === b.urgent && a.overGrid === b.overGrid;

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
    for (const e of lines.values()) {
      if (e.line.ttlMs != null && now - e.at > e.line.ttlMs) continue;
      if (otherPills > 0 && !e.line.overGrid) continue;
      if (!best || e.line.priority > best.line.priority ||
          (e.line.priority === best.line.priority && e.seq > best.seq)) best = e;
    }
    return best?.line ?? null;
  },
};
