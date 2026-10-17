import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertState, bytes, clampInt, COOLDOWN, heat, pct, rate, showOf, spark } from "../src/modules/sysmon/logic.ts";

const lim = { cpu: 90, ram: 90, disk: 95, temp: 85 };

test("bytes and percent formatting", () => {
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(1536), "1,5 KB");
  assert.equal(bytes(150 * 1024 * 1024), "150 MB");
  assert.equal(bytes(-1), "–");
  assert.equal(pct(null), "–");
  assert.equal(pct(41.6), "42%");
});

test("showOf fills defaults and ignores junk", () => {
  assert.deepEqual(showOf(null).cpu, true);
  assert.equal(showOf({ gpu: false, cpu: "no" }).gpu, false);
  assert.equal(showOf({ gpu: false, cpu: "no" }).cpu, true);
  assert.equal("top" in showOf({ top: true }), false, "the removed top-apps key is ignored");
});

test("rates and temperature bands", () => {
  assert.equal(rate(0), "0 B/s");
  assert.equal(rate(2048), "2,0 KB/s");
  assert.equal(rate(null), "–");
  assert.equal(heat(50, 85), "cool");
  assert.equal(heat(65, 85), "warm");
  assert.equal(heat(85, 85), "hot");
});

test("sparkline is right-aligned, clamped, and empty below two points", () => {
  assert.deepEqual(spark([5]), { line: "", area: "" });
  const p = spark([0, 100], 3);
  assert.equal(p.line, "M50.00,23.00L100.00,1.00");
  assert.equal(p.area, "M50.00,23.00L100.00,1.00L100,24L50.00,24Z");
  assert.equal(spark([-50, 200], 2).line, "M0.00,23.00L100.00,1.00");
  assert.equal(spark(Array.from({ length: 40 }, () => 1)).line.split("L").length, 30, "keeps the last 30");
});

test("clampInt", () => {
  assert.equal(clampInt("85", 40, 120, 1), 85);
  assert.equal(clampInt("5", 40, 120, 1), 1);
  assert.equal(clampInt("x", 40, 120, 1), 1);
});

test("alert needs two checks in a row, then stays quiet for the cooldown", () => {
  const a = new AlertState();
  assert.deepEqual(a.step({ cpu: 95 }, lim), []);
  assert.deepEqual(a.step({ cpu: 96 }, lim), ["cpu"]);
  for (let i = 0; i < COOLDOWN - 1; i++) assert.deepEqual(a.step({ cpu: 99 }, lim), []);
  assert.deepEqual(a.step({ cpu: 99 }, lim), ["cpu"]);
});

test("a dip resets the streak; an unmeasured round keeps it", () => {
  const a = new AlertState();
  a.step({ ram: 95 }, lim);
  assert.deepEqual(a.step({ ram: 50 }, lim), []);
  assert.deepEqual(a.step({ ram: 95 }, lim), []);
  assert.deepEqual(a.step({}, lim), []);
  assert.deepEqual(a.step({ ram: 95 }, lim), ["ram"]);
  const b = new AlertState();
  b.step({ cpu: 95 }, lim);
  assert.deepEqual(b.step({ cpu: null }, lim), []);
  assert.deepEqual(b.step({ cpu: 95 }, lim), []);
});
