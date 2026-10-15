import { test } from "node:test";
import assert from "node:assert/strict";
import { Compact } from "../src/core/compact.ts";
import { Avatar } from "../src/core/avatar.ts";
import { Hooks, Services, homeOf } from "../src/core/hooks.ts";
import { resolveEnabled } from "../src/core/moduleApi.ts";
import { MODULE_INFO } from "./catalog.ts";

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
  // Only the shipped-on defaults are listed: a new module (scripts/new-module.mjs) must not edit this test.
  const defaults = resolveEnabled(MODULE_INFO, {});
  assert.deepEqual(Object.keys(defaults).filter((id) => defaults[id]), ["board", "claude", "media", "upload"]);
  const r = resolveEnabled(MODULE_INFO, { claude: false, voice: true });
  assert.equal(r.voice, false);
  assert.equal(r.upload, false);
});

test("Hooks.home: the highest priority wins", () => {
  const offs = [Hooks.provide("homeView", () => ({ view: "a", priority: 5 })), Hooks.provide("homeView", () => ({ view: "b", priority: 9 }))];
  assert.equal(Hooks.home()?.view, "b");
  offs.forEach((off) => off());
  assert.equal(Hooks.home(), null);
});

test("pill badge: applyBadge reports change only", async () => {
  const { applyBadge } = await import("../src/core/badge.ts");
  const pills = [{ id: "a", label: "a", color: "#000", mood: "idle" as const }];
  assert.equal(applyBadge(pills, "a", "error"), true);
  assert.equal(applyBadge(pills, "a", "error"), false);
  assert.equal(applyBadge(pills, "zz", "error"), false);
  assert.equal(applyBadge(pills, "a", null), true);
});

test("old mood/badge/sound aliases are gone", async () => {
  const badge = await import("../src/core/badge.ts");
  // layout imports core/moduleApi values by extensionless path, which plain node cannot load: read its source.
  const layout = (await import("node:fs")).readFileSync(new URL("../src/core/layout.ts", import.meta.url), "utf8");
  const sound = await import("../src/core/sound.ts");
  for (const k of ["badgeName", "BADGE_ALIAS"]) assert.equal(k in badge, false);
  for (const k of ["moodName", "MOOD_ALIAS"]) assert.equal(layout.includes(k), false);
  for (const k of ["soundName", "SOUND_ALIAS"]) assert.equal(k in sound, false);
  for (const n of ["alert", "ask", "wait", "attach"]) assert.ok((sound.SOUND_NAMES as readonly string[]).includes(n));
  for (const n of ["approval", "question", "rate"]) assert.equal((sound.SOUND_NAMES as readonly string[]).includes(n), false);
});

test("every sound name has a WAV file", async () => {
  const { SOUND_NAMES } = await import("../src/core/sound.ts");
  const { existsSync } = await import("node:fs");
  for (const n of SOUND_NAMES) assert.ok(existsSync(new URL(`../sounds/${n}.wav`, import.meta.url)), n);
});

test("pills: owner stamp, patch, order, owner-only removal, focus fallback", async () => {
  const { putPill, dropPills } = await import("../src/core/pills.ts");
  const s = { pills: [] as import("../src/core/state.ts").Pill[], focusId: null as string | null };
  assert.equal(putPill(s, "m", { id: "x", mood: "idle" }), false); // new pill needs label + color
  assert.equal(putPill(s, "m", { id: "b", label: "B", color: "#111" }), true);
  assert.equal(putPill(s, "m", { id: "a", label: "A", color: "#222" }, "start"), true);
  assert.equal(putPill(s, "m", { id: "c", label: "C", color: "#333" }, { after: "a" }), true);
  assert.equal(putPill(s, "m", { id: "d", label: "D", color: "#444" }, { before: "b" }), true);
  assert.deepEqual(s.pills.map((p) => p.id), ["a", "c", "d", "b"]);
  assert.equal(s.pills[0].owner, "m");
  assert.equal(putPill(s, "m", { id: "a", mood: "done", badge: "alert" }), true);
  assert.equal(putPill(s, "m", { id: "a", mood: "done" }), false); // no change
  assert.equal(putPill(s, "other", { id: "a", mood: "error" }), false); // not its pill
  assert.equal(dropPills(s, "other"), false);
  s.focusId = "a";
  assert.equal(dropPills(s, "m", "a"), true);
  assert.equal(s.focusId, "c");
  assert.equal(dropPills(s, "m"), true);
  assert.deepEqual(s.pills, []);
  assert.equal(s.focusId, null);
});

test("homeOf: request wins, else first tab, else empty", async () => {
  const { homeOf } = await import("../src/core/hooks.ts");
  const tabs = [{ view: "timer" }, { view: "media" }];
  assert.equal(homeOf({ view: "overview", priority: 10 }, tabs), "overview");
  assert.equal(homeOf(null, tabs), "timer");
  assert.equal(homeOf(null, []), "empty");
});

test("homeOf: request > tab flagged home > first tab > empty", () => {
  const tabs = [{ view: "a" }, { view: "b", home: true as const }, { view: "c" }];
  assert.equal(homeOf({ view: "x", priority: 1 }, tabs), "x");
  assert.equal(homeOf(null, tabs), "b");
  assert.equal(homeOf(null, [{ view: "a" }, { view: "c" }]), "a");
  assert.equal(homeOf(null, []), "empty");
});

test("Services: several providers, removed on dispose, missing is empty", () => {
  assert.deepEqual(Services.all("x.y"), []);
  const a = Services.provide("x.y", 1), b = Services.provide("x.y", 2);
  assert.deepEqual(Services.all("x.y"), [1, 2]);
  a();
  assert.deepEqual(Services.all("x.y"), [2]);
  b();
  assert.deepEqual(Services.all("x.y"), []);
});

test("resolveEnabled: the board is on by default, requires nothing, and claude off leaves it on", () => {
  assert.equal(resolveEnabled(MODULE_INFO, {}).board, true);
  assert.equal(resolveEnabled(MODULE_INFO, { claude: false }).board, true);
});
