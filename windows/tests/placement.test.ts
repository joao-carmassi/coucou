import { test } from "node:test";
import assert from "node:assert/strict";
import { commitDx } from "../src/island/placement.ts";

test("commitDx: Alt required, release of a real move commits, clamped", () => {
  assert.equal(commitDx(false, true, 80, 200), null);
  assert.equal(commitDx(true, false, 80, 200), null);
  assert.equal(commitDx(true, true, 0.4, 200), null);
  assert.equal(commitDx(true, true, 80, 200), 80);
  assert.equal(commitDx(true, true, -500, 200), -200);
});

test("commitDx: repeated drags are separate commits (the host adds them up)", () => {
  const sent = [commitDx(true, true, 50, 200), commitDx(true, true, 30, 200)];
  assert.equal(sent.reduce((a, d) => a + (d ?? 0), 0), 80);
});
