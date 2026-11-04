import { test } from "node:test";
import assert from "node:assert/strict";
import { NavHistory, type NavEntry } from "../src/core/history.ts";

const yes = () => true;
const e = (view: string, state?: unknown): NavEntry => ({ view, state });

test("push: same view and state as the current one is a no-op", () => {
  const h = new NavHistory();
  h.push(e("a"));
  h.push(e("a"));
  const s = { n: 1 };
  h.push(e("a", s));
  h.push(e("a", s));
  assert.equal(h.step(-1, "a", yes)?.view, "a");
  assert.equal(h.step(-1, "a", yes), null);
});

test("back, forward, both ends", () => {
  const h = new NavHistory();
  ["a", "b", "c"].forEach((v) => h.push(e(v)));
  assert.equal(h.step(1, "c", yes), null);
  assert.equal(h.step(-1, "c", yes)?.view, "b");
  assert.equal(h.step(-1, "b", yes)?.view, "a");
  assert.equal(h.step(-1, "a", yes), null);
  assert.equal(h.step(1, "a", yes)?.view, "b");
});

test("push after going back cuts the forward part", () => {
  const h = new NavHistory();
  ["a", "b", "c"].forEach((v) => h.push(e(v)));
  h.step(-1, "c", yes);
  h.push(e("d"));
  assert.equal(h.step(1, "d", yes), null);
  assert.equal(h.step(-1, "d", yes)?.view, "b");
});

test("cap: the oldest is dropped", () => {
  const h = new NavHistory(3);
  ["a", "b", "c", "d"].forEach((v) => h.push(e(v)));
  assert.equal(h.step(-1, "d", yes)?.view, "c");
  assert.equal(h.step(-1, "c", yes)?.view, "b");
  assert.equal(h.step(-1, "b", yes), null);
  const big = new NavHistory();
  for (let i = 0; i < 40; i++) big.push(e(`v${i}`));
  let n = 0, here = "v39";
  for (let x = big.step(-1, here, yes); x; x = big.step(-1, here, yes)) (here = x.view, n++);
  assert.equal(n, 29);
});

test("screen moved without being recorded: back is the current entry itself", () => {
  const h = new NavHistory();
  ["a", "b"].forEach((v) => h.push(e(v)));
  assert.equal(h.step(-1, "request", yes)?.view, "b");
  assert.equal(h.step(-1, "b", yes)?.view, "a");
});

test("entries refused by ok() are dropped and skipped", () => {
  const h = new NavHistory();
  ["a", "x", "y", "b"].forEach((v) => h.push(e(v)));
  const ok = (n: NavEntry) => n.view !== "x" && n.view !== "y";
  assert.equal(h.step(-1, "b", ok)?.view, "a");
  assert.equal(h.step(-1, "a", ok), null);
  assert.equal(h.step(1, "a", ok)?.view, "b");
  const g = new NavHistory();
  ["a", "x", "b"].forEach((v) => g.push(e(v)));
  g.step(-1, "b", yes); g.step(-1, "x", yes);
  assert.equal(g.step(1, "a", (n) => n.view !== "x")?.view, "b");
});
