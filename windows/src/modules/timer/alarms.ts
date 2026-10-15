// Daily alarms: when is the next one. Pure; wall-clock fields are rebuilt with the local Date
// constructor for every candidate day, so midnight, month ends and DST changes need no special case.

export interface Alarm { id: string; time: string; label: string; days: number[]; on: boolean }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseAlarms(raw: unknown): Alarm[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Alarm => !!a && typeof a.id === "string" && typeof a.time === "string" && TIME.test(a.time) && Array.isArray(a.days))
    .map((a) => ({ id: a.id, time: a.time, label: String(a.label ?? ""), days: a.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6), on: a.on !== false }));
}

/** The first instant after `now` at which an enabled alarm rings, with every alarm ringing then; null when none. */
export function nextAlarm(alarms: Alarm[], now: Date): { at: number; alarms: Alarm[] } | null {
  let best: { at: number; alarms: Alarm[] } | null = null;
  for (const a of alarms) {
    if (!a.on) continue;
    const m = TIME.exec(a.time);
    if (!m) continue;
    for (let i = 0; i <= 8; i++) { // 8: a weekday filter + a candidate already past today
      const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, Number(m[1]), Number(m[2]), 0, 0);
      if (c.getTime() <= now.getTime()) continue;
      if (a.days.length && !a.days.includes(c.getDay())) continue;
      const at = c.getTime();
      if (!best || at < best.at) best = { at, alarms: [a] };
      else if (at === best.at) best.alarms.push(a);
      break;
    }
  }
  return best;
}
