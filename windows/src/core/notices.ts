// The core's queue of short notices (api.island.notice). Pure: no DOM, no timers, time is passed in.
// Highest priority is in front, then the oldest (FIFO). The island owns the single timeout (nextDeadline).

import type { Notice, StatusCard } from "./moduleApi";

export const NOTICE_STALE_MS = 60_000;
export const NOTICE_CAP = 12;
/** Mirror of BAND.URGENT / BAND.NOTICE (this file stays free of value imports; tests/notices.test.ts pins them). */
export const NOTICE_URGENT = 90;
export const NOTICE_DEFAULT_PRIORITY = 60;
const MS_DEFAULT = 4000, MS_MIN = 1500, MS_MAX = 600_000;

export interface NoticeEntry {
  owner: string;
  key?: string;
  text: string;
  card?: StatusCard;
  priority: number;
  ms: number;
  view?: string;
  peek: boolean;
  /** When it was queued (or last replaced): staleness counts from here while it never showed. */
  at: number;
  /** Set once by `shown`: when the on-screen time started. */
  shownAt: number | null;
  seq: number;
}

export class NoticeQueue {
  private list: NoticeEntry[] = [];
  private seq = 0;

  get size(): number {
    return this.list.length;
  }

  /** Same owner+key replaces in place (position kept, on-screen time restarts). Returns the disposer of this notice. */
  add(owner: string, n: Notice, now: number): () => void {
    const priority = Number.isFinite(n.priority) ? (n.priority as number) : NOTICE_DEFAULT_PRIORITY;
    const ms = Math.min(MS_MAX, Math.max(MS_MIN, Number.isFinite(n.ms) ? (n.ms as number) : MS_DEFAULT));
    const fields = { text: n.text, card: n.card, priority, ms, view: n.view, peek: n.peek === true, at: now, shownAt: null };
    let e = n.key != null ? this.list.find((x) => x.owner === owner && x.key === n.key) : undefined;
    if (e) Object.assign(e, fields);
    else this.list.push((e = { owner, key: n.key, seq: ++this.seq, ...fields }));
    if (this.list.length > NOTICE_CAP) {
      let worst = this.list[0];
      for (const x of this.list) if (x.priority < worst.priority || (x.priority === worst.priority && x.seq < worst.seq)) worst = x;
      this.remove(worst);
    }
    const mine = e;
    return () => void this.remove(mine);
  }

  drop(e: NoticeEntry): boolean {
    return this.remove(e);
  }

  private remove(e: NoticeEntry): boolean {
    const at = this.list.indexOf(e);
    if (at >= 0) this.list.splice(at, 1);
    return at >= 0;
  }

  dropOwner(owner: string): void {
    this.list = this.list.filter((e) => e.owner !== owner);
  }

  clear(): void {
    this.list = [];
  }

  /** Highest priority, then oldest. Never-shown entries older than NOTICE_STALE_MS are dropped. `quiet` skips non-urgent ones. */
  front(now: number, quiet: boolean): NoticeEntry | null {
    this.list = this.list.filter((e) => e.shownAt != null || now - e.at <= NOTICE_STALE_MS);
    let best: NoticeEntry | null = null;
    for (const e of this.list) {
      if (quiet && e.priority < NOTICE_URGENT) continue;
      if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq < best.seq)) best = e;
    }
    return best;
  }

  /** Starts the on-screen time, once. */
  shown(e: NoticeEntry, now: number): void {
    if (e.shownAt == null) e.shownAt = now;
  }

  /** Removes the entries whose on-screen time is over; true when any went. */
  expired(now: number): boolean {
    const n = this.list.length;
    this.list = this.list.filter((e) => e.shownAt == null || now < e.shownAt + e.ms);
    return this.list.length !== n;
  }

  /** The earliest moment something changes (an on-screen time ends, or a waiting entry goes stale); null when empty. */
  nextDeadline(_now?: number): number | null {
    let d: number | null = null;
    for (const e of this.list) {
      const t = e.shownAt != null ? e.shownAt + e.ms : e.at + NOTICE_STALE_MS + 1;
      if (d == null || t < d) d = t;
    }
    return d;
  }
}
