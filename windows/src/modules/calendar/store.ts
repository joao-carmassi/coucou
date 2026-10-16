// What the module holds in memory: parsed feeds by slot, events from other modules, and the expanded window (memoised).
import { expand, type Occurrence, type RawEvent } from "./ics.ts";
import { dayRange } from "./plan.ts";
import type { CalendarSourceEvent } from "./api";

const HALF_HOUR = 30 * 60_000;

export class CalendarStore {
  private feeds = new Map<number, RawEvent[]>();
  private ext: Occurrence[] = [];
  private memo: { from: number; days: number; tz: string; v: number; out: Occurrence[] } | null = null;
  private v = 0;

  has(slot: number) { return this.feeds.has(slot); }
  set(slot: number, events: RawEvent[]) { this.feeds.set(slot, events); this.v++; }
  drop(slot: number) { if (this.feeds.delete(slot)) this.v++; }
  /** Keep only these slots (a feed removed in Settings). */
  keep(slots: readonly number[]) { for (const s of [...this.feeds.keys()]) if (!slots.includes(s)) this.drop(s); }
  clear() { this.feeds.clear(); this.ext = []; this.memo = null; this.v++; }

  setExternal(list: readonly CalendarSourceEvent[]) {
    this.ext = list.filter((e) => Number.isFinite(e.start)).map((e) => ({
      key: `ext:${e.id}@${e.start}`, uid: `ext:${e.id}`, summary: e.title, location: "", allDay: false, ext: true,
      link: e.link && /^https:\/\//.test(e.link) ? e.link : null, start: e.start, end: e.end && e.end > e.start ? e.end : e.start + HALF_HOUR,
    }));
    this.v++;
  }

  /** Occurrences overlapping today .. today + `days`; recomputed only when the data, the day or the settings changed. */
  occs(now: number, tz: string, days: number): Occurrence[] {
    const { from, to } = dayRange(now, tz, Math.max(0, days - 1));
    const m = this.memo;
    if (m && m.from === from && m.days === days && m.tz === tz && m.v === this.v) return m.out;
    const out = [...[...this.feeds.values()].flatMap((e) => expand(e, from, to, tz)), ...this.ext.filter((o) => o.end > from && o.start < to)].sort((a, b) => a.start - b.start);
    this.memo = { from, days, tz, v: this.v, out };
    return out;
  }
}
