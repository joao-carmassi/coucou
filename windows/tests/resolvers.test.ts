import { test } from "node:test";
import assert from "node:assert/strict";
import { Compact } from "../src/core/compact.ts";
import { Avatar } from "../src/core/avatar.ts";
import { Hooks } from "../src/core/hooks.ts";
import { resolveEnabled } from "../src/core/moduleApi.ts";
import { MODULE_INFO } from "../src/modules/catalog.ts";

const clearCompact = () => ["a", "b", "c"].forEach((o) => Compact.set(o, null));

test("compact: lone line shows; priority decides; overGrid rules", () => {
  clearCompact();
  assert.equal(Compact.resolve(0), null);
  Compact.set("a", { priority: 30, text: "claude" });
  assert.equal(Compact.resolve(0)?.text, "claude");
  Compact.set("b", { priority: 50, text: "timer", overGrid: true });
  assert.equal(Compact.resolve(0)?.text, "timer");
  Compact.set("c", { priority: 100, text: "approval" });
  assert.equal(Compact.resolve(0)?.text, "approval");
  assert.equal(Compact.resolve(2)?.text, "timer"); // others=2: only overGrid lines
  clearCompact();
  assert.equal(Compact.resolve(0), null);
});

test("compact: tie goes to the most recent; expired ttl ignored", () => {
  clearCompact();
  Compact.set("a", { priority: 30, text: "first" }, 0);
  Compact.set("b", { priority: 30, text: "second" }, 1);
  assert.equal(Compact.resolve(0, 2)?.text, "second");
  Compact.set("c", { priority: 90, text: "short", ttlMs: 100 }, 0);
  assert.equal(Compact.resolve(0, 50)?.text, "short");
  assert.equal(Compact.resolve(0, 500)?.text, "second");
  clearCompact();
});

test("avatar: override > signal > fallback", () => {
  Avatar.publish("a", null);
  assert.equal(Avatar.state("idle", null), "idle");
  Avatar.publish("a", { state: "working", priority: 30 });
  Avatar.publish("b", { state: "error", priority: 80 });
  assert.equal(Avatar.state("idle", null), "error");
  assert.equal(Avatar.state("idle", "dizzy"), "dizzy");
  Avatar.publish("b", null);
  assert.equal(Avatar.state("idle", null), "working");
  Avatar.publish("a", null);
});

test("resolveEnabled: defaults and requirements", () => {
  assert.deepEqual(resolveEnabled(MODULE_INFO, {}), {
    claude: true, media: true, upload: true, timer: false, voice: false, github: false, vercel: false, stripe: false, n8n: false, resend: false, calcom: false, notion: false,
  });
  const r = resolveEnabled(MODULE_INFO, { claude: false, voice: true });
  assert.equal(r.voice, false);
  assert.equal(r.upload, false);
});

test("Hooks.home(false) ignores pinned requests", () => {
  const off = Hooks.provide("homeView", () => ({ view: "approval", pin: true, priority: 90 }));
  assert.equal(Hooks.home()?.view, "approval");
  assert.equal(Hooks.home(false), null);
  off();
});

test("pill badge: applyBadge reports change only", async () => {
  const { applyBadge } = await import("../src/core/badge.ts");
  const tasks = [{ id: "a", name: "a", color: "#000", state: "idle" as const }];
  assert.equal(applyBadge(tasks, "a", "error"), true);
  assert.equal(applyBadge(tasks, "a", "error"), false);
  assert.equal(applyBadge(tasks, "zz", "error"), false);
  assert.equal(applyBadge(tasks, "a", null), true);
});
