// What to show and when to remind: pure functions over expanded occurrences.
import type { Occurrence } from "./ics.ts";
import { DAY, addDays, dayKey, midnight, wallOf, wallToMs, ianaZone, UTC, type Day } from "./tz.ts";

const zoneOf = (tz: string) => ianaZone(tz) ?? UTC;

/** [start, end) of the local day holding `now`, plus `plus` more days. */
export function dayRange(now: number, tz: string, plus = 0): { from: number; to: number; day: Day } {
  const z = zoneOf(tz);
  const day = wallOf(now, z);
  return { from: wallToMs(midnight(day), z), to: wallToMs(midnight(addDays(day, 1 + plus)), z), day: { y: day.y, mo: day.mo, d: day.d } };
}

/** Events not over yet, sorted, grouped by the local day they start (a running multi-day event sits on today). */
export function agenda(occs: readonly Occurrence[], now: number, tz: string, daysAhead: number): { day: string; items: Occurrence[] }[] {
  const z = zoneOf(tz);
  const { to, from } = dayRange(now, tz, Math.max(0, daysAhead - 1));
  const groups = new Map<string, Occurrence[]>();
  for (const o of [...occs].sort((a, b) => a.start - b.start)) {
    if (o.end <= now || o.start >= to) continue;
    const key = dayKey(wallOf(Math.max(o.start, from), z));
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
  }
  return [...groups].map(([day, items]) => ({ day, items }));
}

/** The next timed or all-day event that has not started. */
export const nextEvent = (occs: readonly Occurrence[], now: number): Occurrence | null =>
  occs.filter((o) => o.start > now).sort((a, b) => a.start - b.start)[0] ?? null;

/** The timed event running now, if any. */
export const currentEvent = (occs: readonly Occurrence[], now: number): Occurrence | null =>
  occs.filter((o) => !o.allDay && o.start <= now && o.end > now).sort((a, b) => b.start - a.start)[0] ?? null;

/**
 * The next reminder to fire: the earliest timed event that starts after `now` and has not been reminded.
 * `at` is `start - lead`, or `now` when that moment already passed (the app was asleep). `lead` 0 = no reminders.
 */
export function nextReminder(occs: readonly Occurrence[], now: number, leadMin: number, done: ReadonlySet<string>): { at: number; occ: Occurrence } | null {
  if (!(leadMin > 0)) return null;
  let best: Occurrence | null = null;
  for (const o of occs) if (!o.allDay && o.start > now && !done.has(o.key) && (!best || o.start < best.start)) best = o;
  return best ? { at: Math.max(now, best.start - leadMin * 60_000), occ: best } : null;
}

/** "agora", "em 5 min", "em 2 h 10 min", "em 3 dias". */
export function untilText(ms: number): string {
  if (ms <= 0) return "agora";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `em ${min} min`;
  if (min < 24 * 60) return `em ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
  const days = Math.round(ms / DAY);
  return `em ${days} ${days === 1 ? "dia" : "dias"}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (ms: number, tz: string) => {
  const w = wallOf(ms, zoneOf(tz));
  return `${pad(w.h)}:${pad(w.mi)}`;
};

const WEEK = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
/** "Hoje", "Amanhã" or "quinta, 12/03". */
export function dayLabel(key: string, now: number, tz: string): string {
  const [y, mo, d] = key.split("-").map(Number);
  const today = dayRange(now, tz).day;
  const diff = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(today.y, today.mo - 1, today.d)) / DAY);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Amanhã";
  return `${WEEK[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]}, ${pad(d)}/${pad(mo)}`;
}
