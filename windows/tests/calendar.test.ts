import { test } from "node:test";
import assert from "node:assert/strict";
import { expand, meetingLink, parseDuration, parseIcs } from "../src/modules/calendar/ics.ts";
import { parseRule } from "../src/modules/calendar/recur.ts";
import { agenda, currentEvent, dayLabel, dayRange, nextEvent, nextReminder, untilText } from "../src/modules/calendar/plan.ts";
import { CalendarStore } from "../src/modules/calendar/store.ts";
import { ianaZone, nthWeekday, wallToMs, zoneOf } from "../src/modules/calendar/tz.ts";

const NY = "America/New_York", SP = "America/Sao_Paulo";
const U = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const cal = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((e) => `BEGIN:VEVENT\r\nUID:${e.split("\n")[0]}\r\n${e.split("\n").slice(1).join("\r\n")}\r\nEND:VEVENT`).join("\r\n")}\r\nEND:VCALENDAR\r\n`.replace(/~F~/g, "\r\n ");
const run = (ics: string, from: number, to: number, local = "UTC") => expand(parseIcs(ics, local), from, to, local);
const starts = (o: { start: number }[]) => o.map((x) => new Date(x.start).toISOString().slice(0, 16));

test("zones: DST gap, overlap, windows names", () => {
  const ny = ianaZone(NY)!;
  // 2026-03-08 02:30 does not exist in New York: the offset before the jump (EST) applies -> 07:30Z
  assert.equal(wallToMs({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, ny), U(2026, 3, 8, 7, 30));
  // 2026-11-01 01:30 happens twice: the first (EDT) -> 05:30Z
  assert.equal(wallToMs({ y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 }, ny), U(2026, 11, 1, 5, 30));
  assert.equal(zoneOf("E. South America Standard Time")!.offset(U(2026, 1, 1)), -3 * 3600_000);
  assert.equal(zoneOf("Nope/Nope"), null);
  assert.equal(nthWeekday(2026, 3, 0, 2), 8); // second Sunday of March 2026
  assert.equal(nthWeekday(2026, 1, 5, -1), 30); // last Friday of January 2026
});

test("timed events: UTC, floating (local zone), TZID, Windows name", () => {
  const ics = cal(
    "u\nDTSTART:20260315T120000Z\nDTEND:20260315T130000Z\nSUMMARY:utc",
    "f\nDTSTART:20260315T120000\nDURATION:PT45M\nSUMMARY:floating",
    "t\nDTSTART;TZID=America/New_York:20260115T090000\nDTEND;TZID=America/New_York:20260115T100000\nSUMMARY:ny",
    "w\nDTSTART;TZID=E. South America Standard Time:20260115T090000\nSUMMARY:win",
  );
  const all = run(ics, U(2026, 1, 1), U(2026, 4, 1), NY);
  const by = Object.fromEntries(all.map((o) => [o.summary, o]));
  assert.equal(by.utc.start, U(2026, 3, 15, 12));
  assert.equal(by.utc.end - by.utc.start, 3600_000);
  assert.equal(by.floating.start, U(2026, 3, 15, 16)); // EDT
  assert.equal(by.floating.end - by.floating.start, 45 * 60_000);
  assert.equal(by.ny.start, U(2026, 1, 15, 14)); // EST
  assert.equal(by.win.start, U(2026, 1, 15, 12)); // -03
});

test("all-day: a local date, 23 h on the DST day (New York), fixed in Sao Paulo", () => {
  const ics = cal("a\nDTSTART;VALUE=DATE:20260308\nDTEND;VALUE=DATE:20260309\nSUMMARY:dia");
  const [ny] = run(ics, U(2026, 3, 1), U(2026, 4, 1), NY);
  assert.equal(ny.allDay, true);
  assert.equal(ny.start, U(2026, 3, 8, 5));
  assert.equal(ny.end - ny.start, 23 * 3600_000);
  const [sp] = run(ics, U(2026, 3, 1), U(2026, 4, 1), SP);
  assert.equal(sp.start, U(2026, 3, 8, 3));
  assert.equal(sp.end - sp.start, 24 * 3600_000);
  // no DTEND: one day; several days
  const [one] = run(cal("b\nDTSTART;VALUE=DATE:20260310\nSUMMARY:x"), 0, U(2027, 1, 1), SP);
  assert.equal(one.end - one.start, 24 * 3600_000);
  const [three] = run(cal("c\nDTSTART;VALUE=DATE:20260310\nDTEND;VALUE=DATE:20260313\nSUMMARY:x"), 0, U(2027, 1, 1), SP);
  assert.equal(three.end - three.start, 72 * 3600_000);
});

test("RRULE weekly keeps the wall clock across the New York DST change", () => {
  const ics = cal("a\nDTSTART;TZID=America/New_York:20260302T090000\nDTEND;TZID=America/New_York:20260302T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\nSUMMARY:s");
  assert.deepEqual(starts(run(ics, U(2026, 3, 1), U(2026, 4, 1), NY)), ["2026-03-02T14:00", "2026-03-09T13:00", "2026-03-16T13:00"]);
});

test("RRULE daily in Sao Paulo across the 2018 DST start (Nov 4), and none in 2019", () => {
  const ics = cal("a\nDTSTART;TZID=America/Sao_Paulo:20181102T090000\nRRULE:FREQ=DAILY;COUNT=4\nSUMMARY:s");
  assert.deepEqual(starts(run(ics, U(2018, 11, 1), U(2018, 12, 1), SP)), ["2018-11-02T12:00", "2018-11-03T12:00", "2018-11-04T11:00", "2018-11-05T11:00"]);
  const y19 = cal("a\nDTSTART;TZID=America/Sao_Paulo:20191103T090000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:s");
  assert.deepEqual(starts(run(y19, U(2019, 11, 1), U(2019, 12, 1), SP)), ["2019-11-03T12:00", "2019-11-04T12:00", "2019-11-05T12:00"]);
});

test("RRULE: interval, byday list, until, count with exdate, monthly, yearly", () => {
  const r = (rule: string, start = "20260301T100000Z", extra = "") =>
    starts(run(cal(`a\nDTSTART:${start}\nRRULE:${rule}\n${extra}SUMMARY:s`), U(2020, 1, 1), U(2036, 1, 1))).map((s) => s.slice(0, 10));
  assert.deepEqual(r("FREQ=DAILY;INTERVAL=2;COUNT=3"), ["2026-03-01", "2026-03-03", "2026-03-05"]);
  assert.deepEqual(r("FREQ=DAILY;UNTIL=20260303T100000Z"), ["2026-03-01", "2026-03-02", "2026-03-03"]);
  assert.deepEqual(r("FREQ=DAILY;UNTIL=20260302"), ["2026-03-01", "2026-03-02"]); // a date UNTIL is the whole day
  assert.deepEqual(r("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4"), ["2026-03-03", "2026-03-05", "2026-03-10", "2026-03-12"]); // Mar 1 is a Sunday
  assert.deepEqual(r("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3", "20260302T100000Z"), ["2026-03-02", "2026-03-16", "2026-03-30"]);
  assert.deepEqual(r("FREQ=DAILY;COUNT=3", "20260301T100000Z", "EXDATE:20260302T100000Z\n"), ["2026-03-01", "2026-03-03"]); // COUNT counts the excluded one
  assert.deepEqual(r("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "20260130T100000Z"), ["2026-01-30", "2026-02-27", "2026-03-27"]);
  assert.deepEqual(r("FREQ=MONTHLY;COUNT=3", "20260131T100000Z"), ["2026-01-31", "2026-03-31", "2026-05-31"]); // short months are skipped
  assert.deepEqual(r("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "20260131T100000Z"), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.deepEqual(r("FREQ=YEARLY;COUNT=3", "20240229T100000Z"), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  assert.deepEqual(r("FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;COUNT=2", "20260308T100000Z"), ["2026-03-08", "2027-03-14"]);
  assert.equal(parseRule("FREQ=HOURLY"), null);
  assert.deepEqual(r("FREQ=DAILY;BYMONTH=2;COUNT=1"), ["2027-02-01"]);
  assert.deepEqual(r("FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30"), []); // never matches: ends, does not loop
});

test("EXDATE with TZID and an all-day exdate", () => {
  const ics = cal("a\nDTSTART;TZID=America/New_York:20260302T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=America/New_York:20260303T090000\nSUMMARY:s");
  assert.deepEqual(starts(run(ics, U(2026, 3, 1), U(2026, 4, 1), NY)), ["2026-03-02T14:00", "2026-03-04T14:00"]);
  const d = cal("b\nDTSTART;VALUE=DATE:20260302\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;VALUE=DATE:20260303\nSUMMARY:s");
  assert.equal(run(d, U(2026, 3, 1), U(2026, 4, 1), NY).length, 2);
});

test("overrides move or cancel one instance; cancelled events and series drop out", () => {
  const master = "m\nDTSTART:20260301T100000Z\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:serie";
  const moved = "m\nRECURRENCE-ID:20260302T100000Z\nDTSTART:20260302T150000Z\nSUMMARY:movido";
  const gone = "m\nRECURRENCE-ID:20260303T100000Z\nDTSTART:20260303T100000Z\nSTATUS:CANCELLED\nSUMMARY:x";
  const got = run(cal(master, moved, gone), U(2026, 3, 1), U(2026, 4, 1));
  assert.deepEqual(got.map((o) => [o.summary, o.start]), [["serie", U(2026, 3, 1, 10)], ["movido", U(2026, 3, 2, 15)]]);
  assert.equal(run(cal("c\nDTSTART:20260301T100000Z\nSTATUS:CANCELLED\nSUMMARY:x"), 0, U(2030, 1, 1)).length, 0);
  assert.equal(run(cal("c\nDTSTART:20260301T100000Z\nRRULE:FREQ=DAILY\nSTATUS:CANCELLED\nSUMMARY:x"), 0, U(2030, 1, 1)).length, 0);
});

test("VTIMEZONE without a known name: onsets decide the offset", () => {
  const tz = "BEGIN:VTIMEZONE\r\nTZID:Custom Eastern\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700308T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n";
  const ev = cal("a\nDTSTART;TZID=Custom Eastern:20260115T090000\nSUMMARY:w", "b\nDTSTART;TZID=Custom Eastern:20260715T090000\nSUMMARY:s");
  const text = ev.replace("BEGIN:VEVENT", tz + "BEGIN:VEVENT");
  const [w, s] = run(text, U(2026, 1, 1), U(2026, 12, 1));
  assert.equal(w.start, U(2026, 1, 15, 14));
  assert.equal(s.start, U(2026, 7, 15, 13));
});

test("parser: folded and escaped lines, quoted params, meeting links, duration, garbage", () => {
  const ics = cal("a\nDTSTART:20260301T100000Z\nSUMMARY:Reuni~F~ao\\, geral\nDESCRIPTION:Entre: https://meet.google.com/abc-defg-hij\\nobrigado\nLOCATION;ALTREP=\"cid:x:y\":Sala 3");
  const [e] = run(ics, 0, U(2030, 1, 1));
  assert.equal(e.summary, "Reuniao, geral");
  assert.equal(e.link, "https://meet.google.com/abc-defg-hij");
  assert.equal(e.location, "Sala 3");
  assert.equal(meetingLink(["Sala 3"], "http://x.test/"), null);
  assert.equal(meetingLink([""], "https://example.com/e/1"), "https://example.com/e/1");
  assert.equal(meetingLink(["https://evil.test/zoom.us"]), null);
  assert.equal(parseDuration("P1DT2H30M"), (26 * 60 + 30) * 60_000);
  assert.equal(parseDuration("P2W"), 14 * 86_400_000);
  assert.equal(parseDuration("junk"), null);
  assert.deepEqual(parseIcs("not an ics\n\u0000\nBEGIN:VEVENT\nEND:VEVENT", "UTC"), []);
});

test("next event, running event, agenda groups, reminders", () => {
  const now = U(2026, 3, 10, 15, 0); // 11:00 in New York
  const ics = cal(
    "a\nDTSTART:20260310T143000Z\nDTEND:20260310T153000Z\nSUMMARY:rodando",
    "b\nDTSTART:20260310T153000Z\nSUMMARY:daqui a 30",
    "c\nDTSTART:20260310T170000Z\nSUMMARY:depois",
    "d\nDTSTART:20260311T150000Z\nSUMMARY:amanha",
    "e\nDTSTART;VALUE=DATE:20260310\nSUMMARY:dia todo",
    "f\nDTSTART:20260310T120000Z\nDTEND:20260310T130000Z\nSUMMARY:passado",
  );
  const occs = run(ics, U(2026, 3, 10), U(2026, 3, 20), NY);
  assert.equal(currentEvent(occs, now)!.summary, "rodando");
  assert.equal(nextEvent(occs, now)!.summary, "daqui a 30");
  const groups = agenda(occs, now, NY, 2);
  assert.deepEqual(groups.map((g) => [g.day, g.items.map((o) => o.summary)]), [
    ["2026-03-10", ["dia todo", "rodando", "daqui a 30", "depois"]],
    ["2026-03-11", ["amanha"]],
  ]);
  assert.equal(agenda(occs, now, NY, 1).length, 1);
  assert.equal(dayLabel("2026-03-10", now, NY), "Hoje");
  assert.equal(dayLabel("2026-03-11", now, NY), "Amanhã");
  assert.equal(dayLabel("2026-03-13", now, NY), "sexta, 13/03");

  const b = occs.find((o) => o.summary === "daqui a 30")!;
  const r = nextReminder(occs, now, 10, new Set())!;
  assert.equal(r.occ.key, b.key);
  assert.equal(r.at, b.start - 10 * 60_000); // in the future: armed for then
  assert.equal(nextReminder(occs, b.start - 5 * 60_000, 10, new Set())!.at, b.start - 5 * 60_000); // already inside the window: now
  assert.equal(nextReminder(occs, now, 10, new Set([b.key]))!.occ.summary, "depois");
  assert.equal(nextReminder(occs, now, 0, new Set()), null);
  assert.equal(nextReminder(occs.filter((o) => o.allDay), now, 10, new Set()), null);
});

test("day range is 23 h on the spring-forward day; untilText", () => {
  const r = dayRange(U(2026, 3, 8, 17), NY);
  assert.equal(r.to - r.from, 23 * 3600_000);
  assert.equal(untilText(0), "agora");
  assert.equal(untilText(4 * 60_000 - 1), "em 4 min");
  assert.equal(untilText(130 * 60_000), "em 2 h 10 min");
  assert.equal(untilText(3 * 86_400_000), "em 3 dias");
});

test("store: feeds, external events, memo, keep", () => {
  const s = new CalendarStore();
  const now = U(2026, 3, 10, 15);
  s.set(1, parseIcs(cal("a\nDTSTART:20260310T170000Z\nSUMMARY:feed"), "UTC"));
  s.setExternal([{ id: "7", title: "reserva", start: U(2026, 3, 10, 16), link: "https://cal.com/x" }, { id: "8", title: "ruim", start: NaN }]);
  const a = s.occs(now, "UTC", 2);
  assert.deepEqual(a.map((o) => o.summary), ["reserva", "feed"]);
  assert.equal(a[0].end - a[0].start, 30 * 60_000);
  assert.equal(s.occs(now, "UTC", 2), a, "memoised");
  s.keep([]);
  assert.deepEqual(s.occs(now, "UTC", 2).map((o) => o.summary), ["reserva"]);
  s.clear();
  assert.equal(s.occs(now, "UTC", 2).length, 0);
});
