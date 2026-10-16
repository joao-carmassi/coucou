// RRULE: parsing and expansion in the event's own wall clock (so 09:00 stays 09:00 across a DST change).
// shortcut: no BYSETPOS / BYWEEKNO / BYYEARDAY / BYHOUR..., and HOURLY and finer are not expanded; add them when a real feed needs it.
import { DAY, addDays, dim, nthWeekday, wallAsUtc, wallToMs, weekday, type Day, type Wall, type Zone } from "./tz.ts";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: { wall: Wall; utc: boolean; dateOnly: boolean } | null;
  byday: { n: number; wd: number }[];
  bymonthday: number[];
  bymonth: number[];
  wkst: number;
}

const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** `20261231`, `20261231T235959`, `20261231T235959Z`. */
export function parseStamp(v: string): { wall: Wall; utc: boolean; dateOnly: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  return { wall: { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) }, utc: m[7] === "Z", dateOnly: m[4] === undefined };
}

export function parseRule(text: string): Rule | null {
  const kv: Record<string, string> = {};
  for (const part of text.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim().toUpperCase();
  }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(kv.FREQ)) return null;
  const nums = (s?: string) => (s ? s.split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0) : []);
  const byday = (kv.BYDAY ? kv.BYDAY.split(",") : []).flatMap((x) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
    return m ? [{ n: m[1] ? Number(m[1]) : 0, wd: WD.indexOf(m[2]) }] : [];
  });
  const count = kv.COUNT ? Math.floor(Number(kv.COUNT)) : null;
  return {
    freq: kv.FREQ as Freq,
    interval: Math.max(1, Math.floor(Number(kv.INTERVAL)) || 1),
    count: count !== null && count > 0 ? count : null,
    until: kv.UNTIL ? parseStamp(kv.UNTIL) : null,
    byday,
    bymonthday: nums(kv.BYMONTHDAY),
    bymonth: nums(kv.BYMONTH),
    wkst: Math.max(0, WD.indexOf(kv.WKST ?? "MO")),
  };
}

/** The days of one month the rule picks (ascending). */
function monthDays(y: number, mo: number, r: Rule, startDay: number): number[] {
  const last = dim(y, mo);
  const out = new Set<number>();
  if (r.byday.length) {
    for (const { n, wd } of r.byday) {
      if (n !== 0) {
        const d = nthWeekday(y, mo, wd, n);
        if (d !== null) out.add(d);
      } else for (let d = 1; d <= last; d++) if (weekday({ y, mo, d }) === wd) out.add(d);
    }
    // BYMONTHDAY together with BYDAY narrows it (e.g. Friday the 13th).
    if (r.bymonthday.length) for (const d of out) if (!r.bymonthday.some((m) => (m > 0 ? m : last + 1 + m) === d)) out.delete(d);
  } else if (r.bymonthday.length) {
    for (const m of r.bymonthday) {
      const d = m > 0 ? m : last + 1 + m;
      if (d >= 1 && d <= last) out.add(d);
    }
  } else if (startDay <= last) out.add(startDay);
  return [...out].sort((a, b) => a - b);
}

/** Candidate days of period `k` (ascending) and the period's first day, for the stop test. */
function period(r: Rule, start: Day, k: number): { days: Day[]; first: Day } {
  const step = k * r.interval;
  switch (r.freq) {
    case "DAILY": {
      const d = addDays(start, step);
      const ok = (!r.byday.length || r.byday.some((b) => b.wd === weekday(d))) && (!r.bymonth.length || r.bymonth.includes(d.mo))
        && (!r.bymonthday.length || r.bymonthday.some((m) => (m > 0 ? m : dim(d.y, d.mo) + 1 + m) === d.d));
      return { days: ok ? [d] : [], first: d };
    }
    case "WEEKLY": {
      const first = addDays(start, -((weekday(start) - r.wkst + 7) % 7) + 7 * step);
      const wds = r.byday.length ? [...new Set(r.byday.map((b) => b.wd))] : [weekday(start)];
      const days = wds.map((wd) => addDays(first, (wd - r.wkst + 7) % 7)).filter((d) => !r.bymonth.length || r.bymonth.includes(d.mo));
      return { days: days.sort((a, b) => wallAsUtc({ ...a, h: 0, mi: 0, s: 0 }) - wallAsUtc({ ...b, h: 0, mi: 0, s: 0 })), first };
    }
    case "MONTHLY": {
      const t = start.mo - 1 + step;
      const y = start.y + Math.floor(t / 12), mo = (((t % 12) + 12) % 12) + 1;
      if (r.bymonth.length && !r.bymonth.includes(mo)) return { days: [], first: { y, mo, d: 1 } };
      return { days: monthDays(y, mo, r, start.d).map((d) => ({ y, mo, d })), first: { y, mo, d: 1 } };
    }
    case "YEARLY": {
      const y = start.y + step;
      const months = r.bymonth.length ? [...r.bymonth].sort((a, b) => a - b) : [start.mo];
      return { days: months.flatMap((mo) => monthDays(y, mo, r, start.d).map((d) => ({ y, mo, d }))), first: { y, mo: 1, d: 1 } };
    }
  }
}

/** First period index worth visiting for a window starting at pseudo-time lo (a safe underestimate). */
function skipTo(r: Rule, start: Wall, lo: number): number {
  const d = (lo - wallAsUtc({ ...start, h: 0, mi: 0, s: 0 })) / DAY;
  if (d <= 0) return 0;
  const per = r.freq === "DAILY" ? d / r.interval : r.freq === "WEEKLY" ? d / 7 / r.interval : r.freq === "MONTHLY" ? d / 31 / r.interval : d / 366 / r.interval;
  return Math.max(0, Math.floor(per) - 2);
}

/**
 * Start instants of the occurrences from about `from` (2 days of slack; callers filter exactly) up to `to`, in order.
 * DTSTART is always the first occurrence (RFC 5545). COUNT counts every one from the start with plain arithmetic: the zone
 * is consulted (wallToMs) only near the window. Without COUNT the walk jumps to the period before `from`.
 * `cap` bounds a rule that never matches.
 */
export function occurrences(r: Rule, start: Wall, zone: Zone, from: number, to: number, cap = 120_000): number[] {
  const out: number[] = [];
  const lo = from - 2 * DAY, hi = to + 2 * DAY; // wall clocks differ from UTC by under a day
  const untilMs = r.until
    ? r.until.utc ? wallAsUtc(r.until.wall) : wallToMs(r.until.dateOnly ? { ...r.until.wall, h: 23, mi: 59, s: 59 } : r.until.wall, zone)
    : Infinity;
  const clockOf = { h: start.h, mi: start.mi, s: start.s };
  const startPseudo = wallAsUtc(start);
  let n = 0;
  for (let k = r.count === null ? skipTo(r, start, lo) : 0, steps = 0; steps < cap; k++, steps++) {
    const { days, first } = period(r, start, k);
    if (wallAsUtc({ ...first, h: 0, mi: 0, s: 0 }) > hi) break;
    if (k === 0 && !days.some((d) => d.y === start.y && d.mo === start.mo && d.d === start.d)) days.unshift({ y: start.y, mo: start.mo, d: start.d });
    for (const day of days) {
      const pseudo = wallAsUtc({ ...day, ...clockOf });
      if (pseudo < startPseudo) continue;
      if (r.count !== null && ++n > r.count) return out;
      if (pseudo > hi || pseudo - 2 * DAY > untilMs) return out;
      if (pseudo < lo) continue;
      const ms = wallToMs({ ...day, ...clockOf }, zone);
      if (ms > untilMs || ms >= to) return out;
      out.push(ms);
    }
  }
  return out;
}
