import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertState, bytes, clampInt, COOLDOWN, pct, showOf } from "../src/modules/sysmon/logic.ts";

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
