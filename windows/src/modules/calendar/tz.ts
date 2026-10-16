// Wall-clock and zone arithmetic for the calendar. Pure: no DOM, no State.

export interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }
export interface Day { y: number; mo: number; d: number }
/** `offset(utcMs)` = milliseconds to add to UTC to get the wall clock there. */
export interface Zone { id: string; offset(utcMs: number): number }

export const DAY = 86_400_000;
export const UTC: Zone = { id: "UTC", offset: () => 0 };

const fmts = new Map<string, Intl.DateTimeFormat>();
const fmtOf = (tz: string) => {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmts.set(tz, f);
  }
  return f;
};

/** An IANA zone, or null when the runtime does not know the name. */
export function ianaZone(tz: string): Zone | null {
  let f: Intl.DateTimeFormat;
  try { f = fmtOf(tz); } catch { return null; }
  return {
    id: tz,
    offset(utcMs) {
      const t = Math.floor(utcMs / 1000) * 1000;
      const p: Record<string, number> = {};
      for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
    },
  };
}

// Outlook / Exchange send Windows names. Only the common ones; an unknown name falls back to VTIMEZONE, then the local zone.
const WINDOWS: Record<string, string> = {
  "E. South America Standard Time": "America/Sao_Paulo", "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver", "Pacific Standard Time": "America/Los_Angeles", "US Mountain Standard Time": "America/Phoenix",
  "Alaskan Standard Time": "America/Anchorage", "Atlantic Standard Time": "America/Halifax", "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "SA Pacific Standard Time": "America/Bogota", "Central America Standard Time": "America/Guatemala", "Canada Central Standard Time": "America/Regina",
  "Mexico Standard Time": "America/Mexico_City", "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw", "E. Europe Standard Time": "Europe/Chisinau", "GTB Standard Time": "Europe/Bucharest",
  "FLE Standard Time": "Europe/Kiev", "Russian Standard Time": "Europe/Moscow", "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem", "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai", "Singapore Standard Time": "Asia/Singapore", "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul", "AUS Eastern Standard Time": "Australia/Sydney", "New Zealand Standard Time": "Pacific/Auckland",
  "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo", "W. Central Africa Standard Time": "Africa/Lagos",
};

export function zoneOf(tzid: string): Zone | null {
  const name = tzid.replace(/^"|"$/g, "");
  if (["UTC", "Z", "GMT", "Etc/UTC"].includes(name)) return UTC;
  return ianaZone(name) ?? (WINDOWS[name] ? ianaZone(WINDOWS[name]) : null) ?? ianaZone(name.split("/").slice(-2).join("/"));
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Day) => `${d.y}-${pad(d.mo)}-${pad(d.d)}`;

/** The wall clock at an instant. */
export function wallOf(utcMs: number, zone: Zone): Wall {
  const t = new Date(utcMs + zone.offset(utcMs));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

/** Date.UTC maps years 0..99 to 19xx; this does not. */
export function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
}
export const wallAsUtc = (w: Wall) => utcMs(w.y, w.mo, w.d, w.h, w.mi, w.s);

/** The instant of a wall clock. Overlap (clocks go back): the first one. Gap (clocks jump): the offset before the jump, as RFC 5545 says. */
export function wallToMs(w: Wall, zone: Zone): number {
  const u = wallAsUtc(w);
  const o1 = zone.offset(u - DAY), o2 = zone.offset(u + DAY);
  const a = u - o1, b = u - o2;
  if (zone.offset(a) === o1) return a;
  if (zone.offset(b) === o2) return b;
  return a;
}

export const midnight = (d: Day): Wall => ({ y: d.y, mo: d.mo, d: d.d, h: 0, mi: 0, s: 0 });
export const dim = (y: number, mo: number) => new Date(utcMs(y, mo + 1, 0)).getUTCDate();
/** 0 = Sunday. */
export const weekday = (d: Day) => new Date(utcMs(d.y, d.mo, d.d)).getUTCDay();
export function addDays(d: Day, n: number): Day {
  const t = new Date(utcMs(d.y, d.mo, d.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export const daysBetween = (a: Day, b: Day) => Math.round((utcMs(b.y, b.mo, b.d) - utcMs(a.y, a.mo, a.d)) / DAY);
/** The n-th (n > 0) or n-th from the end (n < 0) weekday `wd` of a month; null when the month has none. */
export function nthWeekday(y: number, mo: number, wd: number, n: number): number | null {
  const last = dim(y, mo);
  if (n > 0) {
    const d = 1 + ((wd - weekday({ y, mo, d: 1 }) + 7) % 7) + (n - 1) * 7;
    return d <= last ? d : null;
  }
  const d = last - ((weekday({ y, mo, d: last }) - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}
