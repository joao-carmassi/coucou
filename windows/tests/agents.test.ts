import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESH, KEY_GUARD_MS, apply, keyWord, targetOf, wantsCard } from "../src/modules/agents/logic.ts";

const ev = (name: string, extra: object = {}) => ({ hook_event_name: name, ...extra });

test("apply: a turn walks idle -> thinking -> working -> done", () => {
  let s = apply(FRESH, ev("SessionStart"));
  assert.equal(s.mood, "idle");
  s = apply(s, ev("UserPromptSubmit", { prompt: "  conserta\n o bug " }));
  assert.deepEqual([s.mood, s.step], ["thinking", "conserta o bug"]);
  s = apply(s, ev("PreToolUse", { tool_name: "Shell", tool_input: { command: "npm test" } }));
  assert.deepEqual([s.mood, s.step], ["working", "Shell · npm test"]);
  s = apply(s, ev("PostToolUse"));
  assert.equal(s.mood, "working");
  s = apply(s, ev("Stop", { last_message: "feito" }));
  assert.deepEqual([s.mood, s.done, s.step], ["done", true, "feito"]);
  // The next event clears the end.
  assert.equal(apply(s, ev("UserPromptSubmit")).done, false);
});

test("apply: errors, questions, rate limits and the end of the session", () => {
  assert.deepEqual([apply(FRESH, ev("StopFailure")).mood, apply(FRESH, ev("StopFailure")).error], ["error", true]);
  assert.equal(apply(FRESH, ev("Notification", { message: "Rodar ls?" })).mood, "ask");
  assert.equal(apply(FRESH, ev("Notification", { message: "Rate limit atingido" })).mood, "waiting");
  assert.equal(apply(FRESH, ev("SessionEnd")).ended, true);
  // Anything else leaves the state alone (same object).
  assert.equal(apply(FRESH, ev("Notification", { message: "oi" })), FRESH);
  assert.equal(apply(FRESH, ev("PermissionRequest")), FRESH);
  assert.equal(apply(FRESH, ev("Whatever")), FRESH);
});

test("targetOf: the command, file or address being authorised", () => {
  assert.equal(targetOf("Shell", { command: "rm x" }), "Shell · rm x");
  assert.equal(targetOf("shell", { command: ["git", "push"] }), "shell · git push");
  assert.equal(targetOf("Edit", { file_path: "a.ts" }), "Edit · a.ts");
  assert.equal(targetOf("Tool", {}), "Tool");
  assert.equal(targetOf(undefined, undefined), "Ferramenta");
});

test("wantsCard: every condition is needed", () => {
  const ok = { blocking: true, approve: true, paused: false, held: false };
  assert.equal(wantsCard(ok), true);
  for (const k of ["blocking", "approve"] as const) assert.equal(wantsCard({ ...ok, [k]: false }), false);
  for (const k of ["paused", "held"] as const) assert.equal(wantsCard({ ...ok, [k]: true }), false);
});

test("keyWord: only Y/N, plain, after the guard", () => {
  const key = (k: string, o: object = {}) => ({ key: k, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.equal(keyWord(key("y"), KEY_GUARD_MS), "allow");
  assert.equal(keyWord(key("N"), KEY_GUARD_MS), "deny");
  assert.equal(keyWord(key("y"), KEY_GUARD_MS - 1), null);
  assert.equal(keyWord(key("y", { ctrlKey: true }), 9999), null);
  assert.equal(keyWord(key("y", { repeat: true }), 9999), null);
  assert.equal(keyWord(key("a"), 9999), null);
  assert.equal(keyWord(key("Enter"), 9999), null);
});
