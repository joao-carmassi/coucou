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
