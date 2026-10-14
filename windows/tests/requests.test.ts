import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestQueue } from "../src/core/requests.ts";

test("front: highest priority, newest on a tie", () => {
  const q = new RequestQueue();
  assert.equal(q.front(), null);
  const a = q.add("m1", { view: "a", priority: 10, pin: true });
  const b = q.add("m2", { view: "b", priority: 40 });
  const c = q.add("m3", { view: "c", priority: 40, pin: true });
  assert.equal(q.front(), c);
  assert.equal(q.pinned(), true);
  q.remove(c);
  assert.equal(q.front(), b);
  assert.equal(q.pinned(), false); // the front one does not pin; the lower one does not count
  assert.equal(q.busy(), true);
  q.remove(b);
  assert.equal(q.front(), a);
  assert.equal(q.remove(b), false);
});

test("parked requests stay but do not pin", () => {
  const q = new RequestQueue();
  q.add("m", { view: "a", priority: 1, pin: true });
  q.parked = true;
  assert.equal(q.pinned(), false);
  assert.equal(q.busy(), true);
  q.clear();
  assert.equal(q.busy(), false);
});
