import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeFresh, dueNotices, lineText, resetText, windowText } from "../src/modules/planusage/logic.ts";
import type { AgentUsage } from "../src/modules/agents/api.ts";

const NOW = 1_000_000_000_000;
const codex = (a: number, b: number, resets = NOW + 3_600_000): AgentUsage => ({
  agent: "codex", source: "local", at: NOW,
  windows: [{ label: "5 h", usedPct: a, resetsAt: resets }, { label: "semana", usedPct: b, resetsAt: resets + 86_400_000 }],
});
const claude = (p: number): AgentUsage => ({ agent: "claude", source: "network", at: NOW, windows: [{ label: "5 h", usedPct: p, resetsAt: NOW + 1000 }, { label: "semana", usedPct: 3, resetsAt: null }] });

test("line text: Codex in full, Claude 5 h only when present and without error", () => {
  assert.equal(lineText(codex(17, 4), null, NOW), "Codex 5 h 17% · sem. 4%");
  assert.equal(lineText(codex(17.4, 4.6), claude(23), NOW), "Codex 5 h 17% · sem. 5% | Claude 5 h 23%");
  assert.equal(lineText(null, { ...claude(23), error: "x" }, NOW), null);
  assert.equal(lineText({ ...codex(1, 1), windows: [] }, null, NOW), null);
});

test("a window past its reset shows a dash, not a stale number", () => {
  assert.equal(windowText({ label: "5 h", usedPct: 50, resetsAt: NOW - 1 }, NOW), "5 h –");
  assert.equal(windowText({ label: "5 h", usedPct: null, resetsAt: null }, NOW), "5 h –");
});

test("reset text", () => {
  assert.equal(resetText(NOW + 5 * 60_000, NOW), "reinicia em 5 min");
  assert.equal(resetText(NOW + 130 * 60_000, NOW), "reinicia em 2 h 10 min");
  assert.equal(resetText(NOW + 3 * 86_400_000 + 4 * 3_600_000, NOW), "reinicia em 3 d 4 h");
  assert.equal(resetText(null, NOW), "");
  assert.equal(resetText(NOW, NOW), "");
});

test("90 % notice fires once per reset, again after the window rolls", () => {
  const seen = new Map<string, number>();
  assert.equal(dueNotices(codex(89, 10), seen, NOW).length, 0);
  const first = dueNotices(codex(91, 10), seen, NOW);
  assert.deepEqual(first.map((n) => n.key), ["plan-codex-5 h"]);
  assert.match(first[0].text, /Codex: limite de 5 h em 91%/);
  assert.equal(dueNotices(codex(95, 10), seen, NOW).length, 0, "same reset: silent");
  assert.equal(dueNotices(codex(95, 10, NOW + 7_200_000), seen, NOW).length, 1, "new reset: again");
  assert.equal(dueNotices(codex(10, 99), seen, NOW)[0].key, "plan-codex-semana");
});

test("claude cache is 5 minutes", () => {
  assert.equal(claudeFresh(null, NOW), false);
  assert.equal(claudeFresh(NOW - 299_000, NOW), true);
  assert.equal(claudeFresh(NOW - 300_000, NOW), false);
});

test("line takes Claude's window labelled 5 h wherever it is", () => {
  const c: AgentUsage = { agent: "claude", source: "network", at: NOW, windows: [{ label: "semana", usedPct: 9, resetsAt: null }, { label: "5 h", usedPct: 23, resetsAt: null }] };
  assert.equal(lineText(null, c, NOW), "Claude 5 h 23%");
});

test("fitPlan: Codex + Claude (2 windows each) fit without scroll; many blocks scroll at the cap", async () => {
  const { fitPlan } = await import("../src/modules/planusage/logic.ts");
  const two = fitPlan([2, 2]);
  assert.equal(two.scroll, false);
  assert.ok(two.height <= 320);
  assert.ok(fitPlan([1, 1]).height < two.height);
  const many = fitPlan([2, 2, 2, 2]);
  assert.equal(many.scroll, true);
  assert.equal(many.height, 320);
});
