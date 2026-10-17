import { test } from "node:test";
import assert from "node:assert/strict";
import { rate, costOf, costTotal, fmtTokens, fmtUsd, keepDays, period, cacheHit, split, modelName, lastDays, fitHeight, type Totals } from "../src/modules/aistats/logic.ts";

const t = (o: Partial<Totals>): Totals => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, req: 0, ...o });

test("cost: unknown model is null, not zero; partial is flagged", () => {
  assert.equal(costOf("gpt-5", t({ input: 1e6 })), null);
  assert.equal(costOf("claude-sonnet-4", t({ input: 1e6, output: 1e6 })), 18);
  assert.equal(costOf("claude-opus-4-1", t({ input: 1e6 })), 15);
  assert.equal(costOf("claude-opus-4-5", t({ input: 1e6 })), 5);
  assert.equal(costOf("claude-haiku-4-5", t({ cache_read: 1e6, cache_write: 1e6 })), 0.1 + 1.25);
  const r = costTotal([["claude-sonnet-4", t({ input: 1e6 })], ["gpt-5", t({ input: 1e6 })]]);
  assert.deepEqual(r, { usd: 3, partial: true, missing: ["gpt-5"] });
  assert.equal(costTotal([["gpt-5", t({})]]).partial, false, "a model with no tokens is not missing");
});

test("period: sums the chosen days, ranks models and projects, flags old days without requests", () => {
  const days = [
    { day: "2026-10-15", tok: t({ output: 10 }), models: { "gpt-5": t({ output: 10 }) }, projects: {} },
    { day: "2026-10-17", tok: t({ input: 5, output: 1000, req: 3 }), models: { "claude-opus-4-5": t({ output: 900, req: 2 }), "gpt-5": t({ input: 5, output: 100, req: 1 }) }, projects: { a: 900, b: 5 } },
    { day: "2026-10-16", tok: t({ output: 7, req: 1 }), models: { "claude-opus-4-5": t({ output: 7, req: 1 }) }, projects: { b: 7 } },
  ];
  const now = new Date(2026, 9, 17, 23, 0);
  assert.deepEqual(lastDays(now, 3), ["2026-10-15", "2026-10-16", "2026-10-17"]);
  const today = period(days, lastDays(now, 1));
  assert.deepEqual([today.tok.output, today.tok.req, today.reqPartial], [1000, 3, false]);
  assert.deepEqual(today.models.map((m) => m[0]), ["claude-opus-4-5", "gpt-5"]);
  const week = period(days, lastDays(now, 7));
  assert.deepEqual([week.tok.output, week.tok.req, week.reqPartial], [1017, 4, true]);
  assert.deepEqual(week.projects, [["a", 900], ["b", 12]]);
  assert.deepEqual(split(week.models), { claude: 907, codex: 115 });
  assert.equal(period(days, ["2026-01-01"]).tok.output, 0);
});

test("cache hit, model names, provider split", () => {
  assert.equal(cacheHit(t({ input: 10, cache_read: 30 })), 0.75);
  assert.equal(cacheHit(t({ output: 5 })), null);
  assert.equal(modelName("claude-opus-4-5-20251101"), "opus-4-5");
  assert.equal(modelName("gpt-5-codex"), "gpt-5-codex");
  assert.deepEqual(split([["claude-3-5-haiku-20241022", t({ input: 1 })], ["codex", t({ output: 2 })], ["o3", t({ output: 4 })]]), { claude: 1, codex: 6 });
});

test("view height: fixed parts, under the panel limit", () => {
  assert.equal(fitHeight("week", 9), 298);
  assert.equal(fitHeight("month", 0), 298);
  assert.equal(fitHeight("today", 4), 298);
  assert.equal(fitHeight("today", 0), fitHeight("today", 1));
  assert.equal(fitHeight("today", 2), 258);
  assert.equal(fitHeight("today", 0, true), 128);
});

test("formats and keep-days clamp", () => {
  assert.deepEqual([999, 12_400, 3_500_000, 2e9].map(fmtTokens), ["999", "12 mil", "3,5 M", "2,0 B"]);
  assert.equal(fmtUsd(12.345), "US$ 12,35");
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
