import { test } from "node:test";
import assert from "node:assert/strict";
import { frameMode, levelDue, LEVEL_SEND_GAP_MS } from "../src/companion/policy.ts";

test("frame policy: hidden stops everything, motion runs rAF, a loop-only mood ticks, nothing stops", () => {
  assert.equal(frameMode({ hidden: true, active: true, busy: true }), "stop");
  assert.equal(frameMode({ hidden: false, active: true, busy: true }), "raf");
  assert.equal(frameMode({ hidden: false, active: false, busy: true }), "tick");
  assert.equal(frameMode({ hidden: false, active: false, busy: false }), "stop");
});

test("level messages: at most 15 per second while loud, one zero at the end, none when silent", () => {
  assert.equal(levelDue(0.5, 0, LEVEL_SEND_GAP_MS - 1), false);
  assert.equal(levelDue(0.5, 0, LEVEL_SEND_GAP_MS), true);
  assert.equal(levelDue(0, 0.5, 0), true, "the closing zero is never throttled");
  assert.equal(levelDue(0, 0, 10_000), false, "already silent: nothing to send");
});
