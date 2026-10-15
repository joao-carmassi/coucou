import { test } from "node:test";
import assert from "node:assert/strict";
import { NoticeQueue, NOTICE_CAP, NOTICE_DEFAULT_PRIORITY, NOTICE_STALE_MS, NOTICE_URGENT } from "../src/core/notices.ts";
import { BAND } from "../src/core/moduleApi.ts";

test("constants mirror BAND", () => {
  assert.equal(NOTICE_URGENT, BAND.URGENT);
  assert.equal(NOTICE_DEFAULT_PRIORITY, BAND.NOTICE);
});

test("front: highest priority, then oldest", () => {
  const q = new NoticeQueue();
  q.add("a", { text: "one", priority: 60 }, 0);
  q.add("b", { text: "two", priority: 60 }, 1);
  q.add("c", { text: "three", priority: 70 }, 2);
  assert.equal(q.front(3, false)?.text, "three");
  const q2 = new NoticeQueue();
  q2.add("a", { text: "one" }, 0);
  q2.add("b", { text: "two" }, 1);
  assert.equal(q2.front(2, false)?.text, "one");
});

test("same owner+key replaces in place; other owner does not", () => {
  const q = new NoticeQueue();
  q.add("a", { text: "x", key: "k" }, 0);
  q.add("a", { text: "y", key: "k" }, 5);
  q.add("b", { text: "z", key: "k" }, 6);
  assert.equal(q.size, 2);
  assert.equal(q.front(7, false)?.text, "y");
});

test("a replaced notice restarts its on-screen clock", () => {
  const q = new NoticeQueue();
  q.add("a", { text: "x", key: "k", ms: 2000 }, 0);
  q.shown(q.front(0, false)!, 0);
  q.add("a", { text: "y", key: "k", ms: 2000 }, 1500);
  const e = q.front(1500, false)!;
  assert.equal(e.shownAt, null);
  q.shown(e, 1600);
  assert.equal(q.expired(3000), false);
  assert.equal(q.expired(3600), true);
  assert.equal(q.size, 0);
});

test("cap: over 12 drops the lowest priority, then the oldest", () => {
  const q = new NoticeQueue();
  for (let i = 0; i < NOTICE_CAP; i++) q.add("a", { text: `n${i}`, priority: 60 }, i);
  q.add("a", { text: "low", priority: 10 }, 20);
  assert.equal(q.size, NOTICE_CAP);
  q.add("a", { text: "high", priority: 80 }, 21);
  assert.equal(q.size, NOTICE_CAP);
  const texts: string[] = [];
  for (let e; (e = q.front(22, false)); ) { texts.push(e.text); q.drop(e); }
  assert.ok(!texts.includes("low"));
  assert.ok(texts.includes("high") && texts.includes("n1"));
  assert.ok(!texts.includes("n0"));
});

test("quiet skips non-urgent; stale never-shown ones are dropped", () => {
  const q = new NoticeQueue();
  q.add("a", { text: "plain", priority: 60 }, 0);
  q.add("b", { text: "urgent", priority: 90 }, 1);
  assert.equal(q.front(2, true)?.text, "urgent");
  q.drop(q.front(2, true)!);
  assert.equal(q.front(3, true), null);
  assert.equal(q.size, 1);
  assert.equal(q.front(NOTICE_STALE_MS + 1, false), null);
  assert.equal(q.size, 0);
});

test("shown clock starts once; deadlines; ms clamp", () => {
  const q = new NoticeQueue();
  assert.equal(q.nextDeadline(0), null);
  q.add("a", { text: "x", ms: 10 }, 0); // clamps to 1500
  q.add("b", { text: "y", ms: 99_999 }, 0); // clamps to 15000
  const a = q.front(0, false)!;
  assert.ok(q.nextDeadline(0)! > NOTICE_STALE_MS - 1); // nothing shown: staleness
  q.shown(a, 100);
  q.shown(a, 900);
  assert.equal(a.shownAt, 100);
  assert.equal(q.nextDeadline(100), 1600);
  assert.equal(q.expired(1599), false);
  assert.equal(q.expired(1600), true);
});

test("disposer and dropOwner", () => {
  const q = new NoticeQueue();
  const off = q.add("a", { text: "x" }, 0);
  q.add("b", { text: "y" }, 0);
  off();
  off();
  assert.equal(q.size, 1);
  q.dropOwner("b");
  assert.equal(q.size, 0);
});
