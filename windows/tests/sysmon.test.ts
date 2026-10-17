import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertState, bytes, clampInt, COOLDOWN, fitHeight, FIT_MIN, heat, pct, rate, showOf, spark, usageLine, USAGE_MS } from "../src/modules/sysmon/logic.ts";

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

test("fitHeight: temps off fits the rest exactly; temps on keeps that height (never taller); only temps shows them", () => {
  const all = showOf(null), f = { drives: 2, chipLines: 1, note: false };
  const noTemp = fitHeight({ ...all, temp: false }, f);
  // 56 chrome + 28 body padding + tiles 81 + gap 10 + disk (26 + 2 x 20 - 4)
  assert.equal(noTemp, 56 + 28 + 81 + 10 + 62);
  assert.equal(fitHeight(all, f), noTemp, "temperatures on: capped at the temperatures-off height");
  assert.equal(fitHeight(all, { drives: 2, chipLines: 4, note: true }), noTemp, "more chips or the note only scroll");
  const none = { cpu: false, ram: false, gpu: false, disk: false, net: false, temp: false };
  assert.equal(fitHeight(none, f), FIT_MIN);
  assert.ok(fitHeight({ ...none, cpu: true }, f) < noTemp);
  assert.equal(fitHeight({ ...none, cpu: true, gpu: true }, f), fitHeight({ ...none, ram: true }, f), "tiles are one row");
  assert.equal(fitHeight({ ...none, disk: true, net: true, temp: true }, f), fitHeight({ ...none, disk: true, net: true }, f));
  const only = { ...none, temp: true };
  assert.equal(fitHeight(only, f), FIT_MIN, "only temperatures: sized to them (one chip row fits the minimum)");
  assert.ok(fitHeight(only, { ...f, chipLines: 3 }) > FIT_MIN);
  assert.ok(fitHeight(only, { ...f, note: true }) > fitHeight(only, f), "the LHM note adds height");
  assert.equal(fitHeight(all, { drives: 9, chipLines: 5, note: true }), 320);
});

test("usageLine shows only shown metrics that were read", () => {
  const all = showOf(null);
  assert.equal(usageLine({ cpu: 52.6, ram: 38.2 }, all), "CPU 53% · RAM 38%");
  assert.equal(usageLine({ cpu: 52.6, ram: 38.2, gpu: 36.4 }, all), "CPU 53% · RAM 38% · GPU 36%");
  assert.equal(usageLine({ cpu: 52.6, ram: 38.2, gpu: 36.4 }, { ...all, gpu: false }), "CPU 53% · RAM 38%", "GPU hidden in sysmonShow");
  assert.equal(usageLine({ cpu: 5, ram: 38, gpu: null }, all), "CPU 5% · RAM 38%", "no GPU reading: omitted");
  assert.equal(usageLine({ cpu: null, ram: null, gpu: 9 }, { ...all, cpu: false, ram: false }), "GPU 9%");
  assert.equal(usageLine({ cpu: null, ram: 38 }, all), "RAM 38%");
  assert.equal(usageLine({ cpu: 10, ram: 38 }, { ...all, cpu: false }), "RAM 38%");
  assert.equal(usageLine({ cpu: null, ram: null }, all), null);
  assert.equal(usageLine({ cpu: 5, ram: 5 }, { ...all, cpu: false, ram: false }), null);
  assert.equal(usageLine(null, all), null);
  assert.equal(USAGE_MS, 4000);
});
