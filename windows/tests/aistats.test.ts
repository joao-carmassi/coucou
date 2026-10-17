import { test } from "node:test";
import assert from "node:assert/strict";
import { rate, costOf, costTotal, fmtTokens, keepDays, weekBars, type Totals } from "../src/modules/aistats/logic.ts";

const t = (o: Partial<Totals>): Totals => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, ...o });

test("cost: unknown model is null, not zero; partial is flagged", () => {
  assert.equal(costOf("gpt-5", t({ input: 1e6 })), null);
  assert.equal(costOf("claude-sonnet-4", t({ input: 1e6, output: 1e6 })), 18);
  assert.equal(costOf("claude-opus-4-1", t({ input: 1e6 })), 15);
  assert.equal(costOf("claude-opus-4-5", t({ input: 1e6 })), 5);
  assert.equal(costOf("claude-haiku-4-5", t({ cache_read: 1e6, cache_write: 1e6 })), 0.1 + 1.25);
  const r = costTotal([["claude-sonnet-4", t({ input: 1e6 })], ["gpt-5", t({ input: 1e6 })]]);
  assert.deepEqual(r, { usd: 3, partial: true });
});

test("week bars: 7 local days, biggest is 100, tiny non-empty days keep 4", () => {
  const now = new Date(2026, 9, 17, 23, 0);
  const days = [
    { day: "2026-10-17", tok: t({ output: 1000 }) },
    { day: "2026-10-15", tok: t({ output: 10 }) },
    { day: "2026-10-01", tok: t({ output: 999 }) }, // outside the week
  ];
  const b = weekBars(days, now);
  assert.equal(b.length, 7);
  assert.equal(b[0].day, "2026-10-11");
  assert.equal(b[6].pct, 100);
  assert.equal(b[4].pct, 4);
  assert.equal(b[0].pct, 0);
  assert.equal(weekBars([], now).every((r) => r.pct === 0), true);
});

test("formats and keep-days clamp", () => {
  assert.deepEqual([999, 12_400, 3_500_000, 2e9].map(fmtTokens), ["999", "12 mil", "3.5 M", "2.0 B"]);
  assert.deepEqual(["x", 0, 30.7, 9999].map(keepDays), [90, 90, 30, 365]);
});

test("price table: versions, date suffixes and old-style ids", () => {
  assert.deepEqual(rate("claude-opus-4-20250514"), [15, 75, 0.1], "a date is not a minor version");
  assert.deepEqual(rate("claude-opus-4-1-20250805"), [15, 75, 0.1]);
  assert.deepEqual(rate("claude-opus-4-5-20251101"), [5, 25, 0.1]);
  assert.deepEqual(rate("claude-opus-5"), [5, 25, 0.1]);
  assert.deepEqual(rate("claude-opus-5-5"), [4, 20, 0.05]);
  assert.deepEqual(rate("claude-sonnet-4-20250514"), [3, 15, 0.1]);
  assert.deepEqual(rate("claude-sonnet-5"), [2, 10, 0.1]);
  assert.deepEqual(rate("claude-sonnet-5-5"), [2, 10, 0.05]);
  assert.deepEqual(rate("claude-3-5-haiku-20241022"), [0.8, 4, 0.1]);
  assert.deepEqual(rate("claude-haiku-4-5-20251001"), [1, 5, 0.1]);
  assert.deepEqual(rate("claude-3-5-sonnet-20241022"), [3, 15, 0.1]);
  assert.deepEqual(rate("fable-5"), [10, 50, 0.1]);
  assert.deepEqual(rate("mythos-5-1"), [10, 50, 0.025]);
  assert.equal(rate("claude-opus"), null);
  assert.equal(rate("gpt-5"), null);
  assert.equal(costOf("claude-opus-5-5", t({ cache_read: 1e6 })), 0.2);
});
