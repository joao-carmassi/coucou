import { test } from "node:test";
import assert from "node:assert/strict";
import { appName, dayKey, dayTotal, enabledKinds, fmtDur, intervalMin, lastDays, parseExcluded, pickKind, roundOf, topApps } from "../src/modules/eyecare/logic.ts";

test("interval: 0 is off, otherwise clamped to 5..60", () => {
  assert.deepEqual([0, -3, "x", null, 1, 20, 20.9, 999].map(intervalMin), [0, 0, 0, 0, 5, 20, 20, 60]);
});

test("kinds rotate over the enabled ones only", () => {
  const k = enabledKinds(["water", "eyes", "nope"]);
  assert.deepEqual(k, ["eyes", "water"]);
  assert.deepEqual([0, 1, 2].map((n) => pickKind(k, n)), ["eyes", "water", "eyes"]);
  assert.equal(pickKind(enabledKinds("bad"), 0), null);
});

test("a reminder waits when busy, skips a repeated absence, counts a rest, else asks", () => {
  const iv = 20 * 60_000;
  assert.equal(roundOf(30_000, true, iv), "wait");
  assert.equal(roundOf(30 * 60_000, true, iv), "wait");
  assert.equal(roundOf(null, false, iv), "ask");
  assert.equal(roundOf(30_000, false, iv), "ask");
  assert.equal(roundOf(5 * 60_000, false, iv), "taken");
  assert.equal(roundOf(iv + 5 * 60_000 - 1, false, iv), "taken"); // the last round still saw an active user
  assert.equal(roundOf(iv + 5 * 60_000, false, iv), "skip");
  // The shortest interval (5 min) still counts an absence once.
  assert.equal(roundOf(5 * 60_000, false, 5 * 60_000), "taken");
  assert.equal(roundOf(10 * 60_000, false, 5 * 60_000), "skip");
});

test("usage sums, sorts and formats", () => {
  const days = { "2026-03-01": { "a.exe": 600, "b.exe": 4000 }, "2026-03-02": { "a.exe": 5000 } };
  assert.deepEqual(topApps(days, ["2026-03-01", "2026-03-02"], 1), [{ exe: "a.exe", secs: 5600 }]);
  assert.deepEqual(topApps(days, ["2026-03-01", "2026-03-09"], 5).map((a) => a.exe), ["b.exe", "a.exe"]);
  assert.equal(dayTotal(days["2026-03-01"]), 4600);
  assert.equal(dayTotal(undefined), 0);
  assert.deepEqual([30, 840, 3600, 7500].map(fmtDur), ["< 1 min", "14 min", "1 h 00", "2 h 05"]);
  assert.equal(appName("Code.EXE"), "Code");
});

test("day keys are local and the week ends today", () => {
  const now = new Date(2026, 2, 2, 23, 59);
  assert.equal(dayKey(now), "2026-03-02");
  assert.deepEqual(lastDays(now, 3), ["2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("exclusion list: lowercase, deduplicated, any separator", () => {
  assert.deepEqual(parseExcluded("Chrome.exe, code.exe;CHROME.EXE\n x.exe"), ["chrome.exe", "code.exe", "x.exe"]);
  assert.deepEqual(parseExcluded("  "), []);
});

test("break rounds: sums, streak, time since the last one", async () => {
  const { breaksOf, streak, since, NO_BREAKS } = await import("../src/modules/eyecare/logic.ts");
  const b = { days: { "2026-03-08": [3, 1], "2026-03-09": [4, 2], "2026-03-10": [2, 0] } as Record<string, [number, number]>, last: 1 };
  assert.deepEqual(breaksOf(b, ["2026-03-09", "2026-03-10", "2026-03-11"]), [6, 2]);
  assert.equal(streak(b, new Date(2026, 2, 10, 9)), 2, "today has none yet: counted from yesterday");
  b.days["2026-03-10"] = [2, 1];
  assert.equal(streak(b, new Date(2026, 2, 10, 9)), 3);
  assert.equal(streak(b, new Date(2026, 2, 12, 9)), 0, "a day without breaks ends it");
  assert.equal(streak(NO_BREAKS, new Date()), 0);
  const now = 10 * 86_400_000;
  assert.deepEqual([0, now - 30_000, now - 42 * 60_000, now - 125 * 60_000, now - 86_400_000, now - 3 * 86_400_000].map((t) => since(t, now)),
    [null, "agora", "há 42 min", "há 2 h 05", "há 1 dia", "há 3 dias"]);
});

test("view heights: fixed parts add up, the week does not depend on rows", async () => {
  const { fitHeight } = await import("../src/modules/eyecare/logic.ts");
  assert.equal(fitHeight("today", 0), 212);
  assert.equal(fitHeight("today", 5), 292);
  assert.equal(fitHeight("week", 0), 272);
  assert.ok(fitHeight("today", 5) <= 320);
});
