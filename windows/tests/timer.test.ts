import { test } from "node:test";
import assert from "node:assert/strict";
import { TimerClock } from "../src/modules/timer/timer.ts";
import { resolveEnabled } from "../src/core/moduleApi.ts";
import { MODULE_INFO } from "./catalog.ts";

test("countdown: idle -> ready -> running -> paused -> running -> done", () => {
  let t = 1_000;
  const c = new TimerClock(() => t);
  let changes = 0;
  c.onChange = () => changes++;
  assert.equal(c.status, "idle");
  assert.equal(c.text(), "");
  c.start(); // ignored unless ready
  assert.equal(c.status, "idle");
  c.prepare("countdown", 5);
  assert.equal(c.status, "ready");
  assert.equal(c.active, false);
  assert.equal(c.text(), "05:00");
  c.start();
  assert.equal(c.status, "running");
  assert.equal(c.active, true);
  t += 61_500;
  assert.equal(c.value(), 238_500);
  assert.equal(c.text(), "03:59"); // ceil
  c.pause();
  t += 999_999; // paused time does not count
  assert.equal(c.status, "paused");
  assert.equal(c.value(), 238_500);
  assert.equal(c.fraction(), 238_500 / 300_000);
  c.resume();
  assert.equal(c.remaining(), 238_500);
  t += 238_500;
  assert.equal(c.remaining(), 0);
  assert.equal(c.text(), "00:00");
  c.cancel(); // what the module does when the end timeout fires
  assert.equal(c.status, "idle");
  assert.equal(changes, 5);
});

test("stopwatch counts up, pauses, formats hours", () => {
  let t = 0;
  const c = new TimerClock(() => t);
  c.prepare("stopwatch");
  c.start();
  t += 3_661_000;
  assert.equal(c.text(), "1:01:01");
  c.pause();
  t += 5_000;
  assert.equal(c.value(), 3_661_000);
  c.resume();
  t += 1_000;
  assert.equal(c.text(), "1:01:02");
});

test("reset clears state and listener without notifying", () => {
  const c = new TimerClock(() => 0);
  let n = 0;
  c.onChange = () => n++;
  c.prepare("countdown", 1);
  c.reset();
  assert.equal(c.status, "idle");
  c.cancel();
  assert.equal(n, 1);
});

test("timer module is off by default, on when enabled", async () => {
  assert.equal(resolveEnabled(MODULE_INFO, {}).timer, false);
  assert.equal(resolveEnabled(MODULE_INFO, { timer: true }).timer, true);
});

import { pomoNext, pomoStart, pomoCfg, pomoMinutes, POMO_DEFAULTS, type PomoState } from "../src/modules/timer/pomodoro.ts";
import { nextAlarm, type Alarm } from "../src/modules/timer/alarms.ts";

test("pomodoro: 4 cycles, long break on the 4th, then back to cycle 1", () => {
  const seq: string[] = [];
  let s: PomoState = pomoStart();
  for (let i = 0; i < 9; i++) { seq.push(`${s.phase}${s.cycle}`); s = pomoNext(s, POMO_DEFAULTS); }
  assert.deepEqual(seq, ["work1", "short1", "work2", "short2", "work3", "short3", "work4", "long4", "work1"]);
  assert.equal(pomoMinutes({ phase: "long", cycle: 4 }, POMO_DEFAULTS), 15);
  assert.equal(pomoNext({ phase: "work", cycle: 2 }, { ...POMO_DEFAULTS, every: 2 }).phase, "long");
});

test("pomodoro: bad settings fall back to defaults", () => {
  assert.deepEqual(pomoCfg({ work: 0, short: "x", long: 30, every: 99 }), { ...POMO_DEFAULTS, long: 30 });
  assert.deepEqual(pomoCfg(null), POMO_DEFAULTS);
});

const al = (time: string, days: number[] = [], on = true): Alarm => ({ id: time, time, label: "", days, on });

test("alarms: today, tomorrow across midnight, disabled, equal time", () => {
  const now = new Date(2026, 0, 14, 23, 30, 0); // Wednesday
  assert.equal(nextAlarm([al("23:45")], now)!.at, new Date(2026, 0, 14, 23, 45).getTime());
  assert.equal(nextAlarm([al("07:00")], now)!.at, new Date(2026, 0, 15, 7, 0).getTime());
  assert.equal(nextAlarm([al("23:30")], now)!.at, new Date(2026, 0, 15, 23, 30).getTime()); // not "now"
  assert.equal(nextAlarm([al("07:00", [], false)], now), null);
  assert.equal(nextAlarm([al("07:00"), al("07:00")], now)!.alarms.length, 2);
});

test("alarms: day filter (0 = Sunday) and month/year rollover", () => {
  const now = new Date(2026, 11, 31, 12, 0, 0); // Thursday
  assert.equal(nextAlarm([al("09:00", [0])], now)!.at, new Date(2027, 0, 3, 9, 0).getTime()); // Sunday
  assert.equal(nextAlarm([al("13:00", [4])], now)!.at, new Date(2026, 11, 31, 13, 0).getTime());
  assert.equal(nextAlarm([al("11:00", [4])], now)!.at, new Date(2027, 0, 7, 11, 0).getTime()); // a week later
});

test("alarms: always local wall time, so a DST change cannot shift it", () => {
  // Whatever the machine's zone does, the result must read back as the requested HH:MM.
  for (const [y, m, d] of [[2026, 2, 8], [2026, 2, 29], [2026, 9, 25], [2026, 10, 1]]) {
    const at = new Date(nextAlarm([al("08:15")], new Date(y, m, d, 20, 0))!.at);
    assert.equal(`${at.getHours()}:${at.getMinutes()}`, "8:15");
  }
});
