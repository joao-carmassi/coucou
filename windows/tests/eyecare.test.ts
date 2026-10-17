import { test } from "node:test";
import assert from "node:assert/strict";
import { appName, dayKey, dayTotal, enabledKinds, fmtDur, intervalMin, lastDays, parseExcluded, pickKind, shouldNotify, topApps } from "../src/modules/eyecare/logic.ts";

test("interval: 0 is off, otherwise clamped to 5..60", () => {
  assert.deepEqual([0, -3, "x", null, 1, 20, 20.9, 999].map(intervalMin), [0, 0, 0, 0, 5, 20, 20, 60]);
});

test("kinds rotate over the enabled ones only", () => {
  const k = enabledKinds(["water", "eyes", "nope"]);
  assert.deepEqual(k, ["eyes", "water"]);
  assert.deepEqual([0, 1, 2].map((n) => pickKind(k, n)), ["eyes", "water", "eyes"]);
  assert.equal(pickKind(enabledKinds("bad"), 0), null);
});

test("a user idle for 5 min or more already rested: no reminder", () => {
  assert.equal(shouldNotify(null), true);
  assert.equal(shouldNotify(30_000), true);
  assert.equal(shouldNotify(5 * 60_000), false);
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
