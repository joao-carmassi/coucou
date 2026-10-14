import { test } from "node:test";
import assert from "node:assert/strict";
import { HoldList } from "../src/core/holds.ts";

const all = () => true;
const MIN = 60_000;

test("most recent wins; touch reorders", () => {
  const h = new HoldList();
  h.add("m", "a", undefined, 1000);
  h.add("m", "b", undefined, 2000);
  assert.equal(h.front(3000, MIN, all), "b");
  h.touch("a", 4000);
  assert.equal(h.front(5000, MIN, all), "a");
});

test("default and per-hold expiry", () => {
  const h = new HoldList();
  h.add("m", "a", undefined, 0);
  h.add("m", "b", 100, 0);
  assert.equal(h.front(50, MIN, all), "b");
  assert.equal(h.front(150, MIN, all), "a");
  assert.equal(h.front(MIN + 1, MIN, all), null);
});

test("default 0 = off; unknown views skipped", () => {
  const h = new HoldList();
  h.add("m", "a", undefined, 0);
  h.add("m", "gone", undefined, 10);
  assert.equal(h.front(20, 0, all), null);
  assert.equal(h.front(20, MIN, (v) => v === "a"), "a");
});

test("dedupe, stale disposer, remover identity", () => {
  const h = new HoldList();
  const off1 = h.add("m", "a", undefined, 0);
  const off2 = h.add("m", "a", undefined, 5); // replaces the first
  off1(); // stale: no-op
  assert.equal(h.front(10, MIN, all), "a");
  h.add("n", "a", undefined, 6); // another owner, same view
  off2();
  assert.equal(h.front(10, MIN, all), "a");
  h.clear();
  assert.equal(h.front(10, MIN, all), null);
});
