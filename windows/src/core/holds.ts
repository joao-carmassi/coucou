// Focus: where the island reopens. Two sources, both pure (no DOM, no timers; time is passed in).
//  - HoldList: sticky holds, an explicit `api.island.hold`. They do NOT expire by time (only with `opts.idleMs`);
//    they end by their disposer, the module stopping, or the user picking the home view.
//  - LastView: the implicit focus, the last view the user left (switching tab, or the island leaving `expanded`).
//    It only counts for `focusHoldMinutes` after that.
// Release-on-action is not built in: a module that wants it calls its hold's disposer from the action handler.

interface Hold { owner: string; view: string; idleMs?: number; seen: number }

export class HoldList {
  private list: Hold[] = [];

  /** Adds (or refreshes) the hold of `owner` on `view`. The remover drops only this hold; a stale one is a no-op. */
  add(owner: string, view: string, idleMs: number | undefined, now: number): () => void {
    this.list = this.list.filter((h) => h.owner !== owner || h.view !== view);
    const h: Hold = { owner, view, idleMs, seen: now };
    this.list.push(h);
    return () => { this.list = this.list.filter((x) => x !== h); };
  }

  /** The view was on screen just now. */
  touch(view: string, now: number) {
    for (const h of this.list) if (h.view === view) h.seen = now;
  }

  /** The most recently seen live hold on a known view. Only holds with `idleMs` expire (unseen that long). */
  front(now: number, known: (v: string) => boolean): string | null {
    this.list = this.list.filter((h) => h.idleMs == null || now - h.seen <= h.idleMs);
    let best: Hold | null = null;
    for (const h of this.list) if (known(h.view) && (!best || h.seen >= best.seen)) best = h;
    return best?.view ?? null;
  }

  clear() { this.list = []; }
}

export class LastView {
  private last: { view: string; at: number } | null = null;

  /** The user left `view` (switched tab, or the island stopped being expanded). */
  left(view: string, now: number) { this.last = { view, at: now }; }

  /** The last view left, unless it is home, unknown, or older than `ms` (<= 0 = implicit focus off). */
  front(now: number, ms: number, home: string, known: (v: string) => boolean): string | null {
    const l = this.last;
    if (!l || !(ms > 0) || now - l.at >= ms) return null;
    return l.view !== home && known(l.view) ? l.view : null;
  }

  clear() { this.last = null; }
}

export const Holds = new HoldList();
export const Last = new LastView();
