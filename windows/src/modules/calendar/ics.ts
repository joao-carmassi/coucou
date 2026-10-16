// iCalendar (RFC 5545) reader: VEVENT with RRULE / EXDATE / RECURRENCE-ID, all-day, TZID + VTIMEZONE, cancelled.
// Pure: no DOM, no State, no clock. The text is a secret feed's body; nothing here logs it.
import { occurrences, parseRule, parseStamp, type Rule } from "./recur.ts";
import {
  UTC, addDays, dayKey, daysBetween, midnight, nthWeekday, wallAsUtc, wallOf, wallToMs, zoneOf, ianaZone,
  type Wall, type Zone,
} from "./tz.ts";

export interface RawEvent {
  uid: string;
  summary: string;
  location: string;
  /** An https meeting link found in the event, or null. */
  link: string | null;
  allDay: boolean;
  start: Wall;
  zone: Zone;
  /** Timed events: length in ms. All-day: whole days in `days`. */
  durationMs: number;
  days: number;
  rule: Rule | null;
  exdates: Set<number>;
  /** Date-only EXDATEs: they remove every instance on that local date (dayKey). */
  exdays: Set<string>;
  /** Set on an override of one instance of a recurring event (the instance's original start). */
  recurrenceId: number | null;
  cancelled: boolean;
}

export interface Occurrence {
  /** uid + start: stable across refreshes. */
  key: string;
  uid: string;
  summary: string;
  location: string;
  link: string | null;
  allDay: boolean;
  start: number;
  end: number;
  /** Came from another source (a service), not from an ICS feed. */
  ext?: boolean;
}

interface Line { name: string; params: Record<string, string>; value: string }

const unescapeText = (v: string) => v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

function parseLine(raw: string): Line | null {
  let q = false, i = 0;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') q = !q;
    else if (c === ":" && !q) break;
  }
  if (i >= raw.length) return null;
  const head: string[] = [];
  let cur = "";
  q = false;
  for (const c of raw.slice(0, i)) {
    if (c === '"') q = !q;
    if (c === ";" && !q) { head.push(cur); cur = ""; } else cur += c;
  }
  head.push(cur);
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const e = p.indexOf("=");
    if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: raw.slice(i + 1) };
}

/** VTIMEZONE reduced to what it takes to tell the offset: each STANDARD / DAYLIGHT onset (DTSTART + yearly RRULE) and its TZOFFSETTO. */
function vtimezoneZone(id: string, obs: { from: number; to: number; start: Wall; rule: Rule | null }[]): Zone | null {
  if (!obs.length) return null;
  const onset = (o: (typeof obs)[number], year: number): number | null => {
    if (!o.rule) return year === o.start.y ? wallAsUtc(o.start) - o.from : null;
    if (year < o.start.y) return null;
    const mo = o.rule.bymonth[0] ?? o.start.mo;
    const b = o.rule.byday[0];
    const d = b && b.n !== 0 ? nthWeekday(year, mo, b.wd, b.n) : o.rule.bymonthday[0] ?? o.start.d;
    return d === null || d === undefined ? null : wallAsUtc({ y: year, mo, d, h: o.start.h, mi: o.start.mi, s: o.start.s }) - o.from;
  };
  return {
    id,
    offset(utcMs) {
      const year = new Date(utcMs).getUTCFullYear();
      let best: { at: number; to: number } | null = null;
      for (const o of obs) for (const y of [year - 1, year, year + 1]) {
        const at = onset(o, y);
        if (at !== null && at <= utcMs && (!best || at > best.at)) best = { at, to: o.to };
      }
      return best ? best.to : obs.reduce((a, o) => (wallAsUtc(o.start) < wallAsUtc(a.start) ? o : a)).to;
    },
  };
}

const offsetMs = (v: string) => {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  return m ? (m[1] === "-" ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] ?? 0)) * 1000 : 0;
};

/** P1DT2H30M, PT45M, P2W. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const MEETING = /(^|\.)(meet\.google\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|around\.co|jitsi\.[a-z]+|meet\.jit\.si|gotomeeting\.com|gotomeet\.me|chime\.aws|discord\.gg|cal\.com|app\.cal\.com)$/;

/** The first https link in the texts that points to a known meeting host; else a plain URL property. */
export function meetingLink(texts: string[], url = ""): string | null {
  for (const t of texts) {
    for (const m of t.matchAll(/https:\/\/[^\s<>"')\]\\]+/g)) {
      try {
        if (MEETING.test(new URL(m[0]).hostname)) return m[0];
      } catch { /* not a URL */ }
    }
  }
  return /^https:\/\//.test(url) && url.length < 2000 ? url : null;
}

const MAX_EVENTS = 20_000;

/** `localTz`: the viewer's zone (all-day events and floating times are read in it). */
export function parseIcs(text: string, localTz: string): RawEvent[] {
  const local = ianaZone(localTz) ?? UTC;
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const zones = new Map<string, Zone>();
  const events: RawEvent[] = [];
  let ev: Line[] | null = null;
  let tz: { id: string; obs: { from: number; to: number; start: Wall; rule: Rule | null }[] } | null = null;
  let sub = 0; // depth of sub-components (VALARM...) inside the current VEVENT
  let ob: { from: number; to: number; start: Wall; rule: Rule | null } | null = null;
  const pending: Line[][] = []; // events wait for the whole file: a VTIMEZONE may come after them
  for (const raw of lines) {
    const l = parseLine(raw);
    if (!l) continue;
    if (ev && l.name === "BEGIN") { sub++; continue; }
    if (ev && sub > 0) { if (l.name === "END") sub--; continue; }
    if (l.name === "BEGIN") {
      if (l.value === "VEVENT") ev = [];
      else if (l.value === "VTIMEZONE") tz = { id: "", obs: [] };
      else if ((l.value === "STANDARD" || l.value === "DAYLIGHT") && tz) ob = { from: 0, to: 0, start: { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0 }, rule: null };
    } else if (l.name === "END") {
      if (l.value === "VEVENT" && ev) { if (pending.length < MAX_EVENTS) pending.push(ev); ev = null; }
      else if ((l.value === "STANDARD" || l.value === "DAYLIGHT") && tz && ob) { tz.obs.push(ob); ob = null; }
      else if (l.value === "VTIMEZONE" && tz) {
        const z = zoneOf(tz.id) ?? vtimezoneZone(tz.id, tz.obs);
        if (z && tz.id) zones.set(tz.id, z);
        tz = null;
      }
    } else if (ev) ev.push(l);
    else if (ob) {
      if (l.name === "TZOFFSETFROM") ob.from = offsetMs(l.value);
      else if (l.name === "TZOFFSETTO") ob.to = offsetMs(l.value);
      else if (l.name === "DTSTART") ob.start = parseStamp(l.value)?.wall ?? ob.start;
      else if (l.name === "RRULE") ob.rule = parseRule(l.value);
    } else if (tz && l.name === "TZID") tz.id = l.value;
  }

  const zoneFor = (l: Line): Zone => {
    if (l.value.endsWith("Z")) return UTC;
    const id = l.params.TZID;
    return id ? zones.get(id) ?? zoneOf(id) ?? local : local;
  };
  const when = (l: Line | undefined) => {
    const s = l && parseStamp(l.value);
    return l && s ? { wall: s.wall, zone: s.dateOnly || l.params.VALUE === "DATE" ? local : zoneFor(l), dateOnly: s.dateOnly } : null;
  };

  for (const props of pending) {
    const get = (n: string) => props.find((p) => p.name === n);
    const st = when(get("DTSTART"));
    if (!st) continue;
    const allDay = st.dateOnly;
    const en = when(get("DTEND"));
    const dur = get("DURATION") ? parseDuration(get("DURATION")!.value) : null;
    let durationMs = 0, days = 1;
    if (allDay) {
      days = en?.dateOnly ? Math.max(1, daysBetween(st.wall, en.wall)) : 1;
    } else if (en) durationMs = Math.max(0, wallToMs(en.wall, en.zone) - wallToMs(st.wall, st.zone));
    else if (dur !== null) durationMs = Math.max(0, dur);
    const exStamps = props.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").flatMap((v) => {
      const x = parseStamp(v);
      return x ? [{ ...x, line: { ...p, value: v } }] : [];
    }));
    const rid = when(get("RECURRENCE-ID"));
    const text = (n: string) => unescapeText(get(n)?.value ?? "");
    const status = get("STATUS")?.value.toUpperCase();
    events.push({
      uid: get("UID")?.value ?? `anon-${events.length}`,
      summary: text("SUMMARY") || "(sem título)",
      location: text("LOCATION"),
      link: meetingLink([props.find((p) => p.name.startsWith("X-GOOGLE-CONFERENCE") || p.name === "X-MICROSOFT-SKYPETEAMSMEETINGURL")?.value ?? "", text("LOCATION"), text("DESCRIPTION")], get("URL")?.value),
      allDay,
      start: st.wall,
      zone: st.zone,
      durationMs,
      days,
      rule: get("RRULE") ? parseRule(get("RRULE")!.value) : null,
      exdates: new Set(exStamps.filter((x) => !x.dateOnly).map((x) => wallToMs(x.wall, x.utc ? UTC : zoneFor(x.line)))),
      exdays: new Set(exStamps.filter((x) => x.dateOnly).map((x) => dayKey(x.wall))),
      recurrenceId: rid ? wallToMs(rid.wall, rid.zone) : null,
      cancelled: status === "CANCELLED",
    });
  }
  return events;
}

const toOccurrence = (e: RawEvent, start: number, local: Zone): Occurrence => ({
  key: `${e.uid}@${start}`,
  uid: e.uid,
  summary: e.summary,
  location: e.location,
  link: e.link,
  allDay: e.allDay,
  start,
  end: e.allDay ? wallToMs(midnight(addDays(wallOf(start, local), e.days)), local) : start + e.durationMs,
});

/** Every occurrence overlapping [from, to), cancelled ones and overridden instances left out; sorted by start. */
export function expand(events: RawEvent[], from: number, to: number, localTz: string): Occurrence[] {
  const local = ianaZone(localTz) ?? UTC;
  const overridden = new Set(events.filter((e) => e.recurrenceId !== null).map((e) => `${e.uid}|${e.recurrenceId}`));
  const out: Occurrence[] = [];
  for (const e of events) {
    if (e.cancelled) continue;
    // An all-day event is a local date: read it in the viewer's zone whatever the feed said.
    const zone = e.allDay ? local : e.zone;
    const starts = e.rule && e.recurrenceId === null
      ? occurrences(e.rule, e.start, zone, from, to).filter((s) => !e.exdates.has(s) && !e.exdays.has(dayKey(wallOf(s, zone))) && !overridden.has(`${e.uid}|${s}`))
      : [wallToMs(e.start, zone)];
    for (const s of starts) {
      const o = toOccurrence(e, s, local);
      if (o.end > from && o.start < to) out.push(o);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}
