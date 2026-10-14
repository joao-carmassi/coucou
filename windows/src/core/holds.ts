// Task holds: views a module marked as unfinished. Pure: no DOM, no timers; time is passed in.

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

  /** The most recently seen live hold on a known view; expired ones are dropped. defaultIdleMs <= 0 = off. */
  front(now: number, defaultIdleMs: number, known: (v: string) => boolean): string | null {
    if (!(defaultIdleMs > 0)) return null;
    this.list = this.list.filter((h) => now - h.seen <= (h.idleMs ?? defaultIdleMs));
    let best: Hold | null = null;
    for (const h of this.list) if (known(h.view) && (!best || h.seen >= best.seen)) best = h;
    return best?.view ?? null;
  }

  clear() { this.list = []; }
}

export const Holds = new HoldList();
