import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldList, LastView } from "../src/core/holds.ts";

const all = () => true;
const MIN = 60_000;

test("sticky: no time expiry; most recent wins; touch reorders", () => {
  const h = new HoldList();
  h.add("m", "a", undefined, 1000);
  h.add("m", "b", undefined, 2000);
  assert.equal(h.front(3000, all), "b");
  h.touch("a", 4000);
  assert.equal(h.front(4000 + 10 * MIN, all), "a");
});

test("idleMs is the only expiry; unknown views skipped", () => {
  const h = new HoldList();
  h.add("m", "a", undefined, 0);
  h.add("m", "b", 100, 0);
  assert.equal(h.front(50, all), "b");
  assert.equal(h.front(150, all), "a");
  assert.equal(h.front(150, (v) => v !== "a"), null);
});

test("dedupe, stale disposer, clear", () => {
  const h = new HoldList();
  const off1 = h.add("m", "a", undefined, 0);
  const off2 = h.add("m", "a", undefined, 5); // replaces the first
  off1(); // stale: no-op
  assert.equal(h.front(10, all), "a");
  h.add("n", "a", undefined, 6);
  off2();
  assert.equal(h.front(10, all), "a");
  h.clear();
  assert.equal(h.front(10, all), null);
});

test("implicit focus: fresh lands, stale/home/unknown/off do not", () => {
  const l = new LastView();
  l.left("media", 0);
  assert.equal(l.front(MIN - 1, MIN, "home", all), "media");
  assert.equal(l.front(MIN + 1, MIN, "home", all), null);
  assert.equal(l.front(10, 0, "home", all), null); // 0 = off
  assert.equal(l.front(10, MIN, "media", all), null); // home itself
  assert.equal(l.front(10, MIN, "home", (v) => v !== "media"), null);
  l.left("timer", 5);
  assert.equal(l.front(10, MIN, "home", all), "timer"); // the last left wins
  l.clear();
  assert.equal(l.front(10, MIN, "home", all), null);
});
