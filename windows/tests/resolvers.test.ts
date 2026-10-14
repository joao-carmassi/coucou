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
  const pills = [{ id: "a", label: "a", color: "#000", mood: "idle" as const }];
  assert.equal(applyBadge(pills, "a", "error"), true);
  assert.equal(applyBadge(pills, "a", "error"), false);
  assert.equal(applyBadge(pills, "zz", "error"), false);
  assert.equal(applyBadge(pills, "a", null), true);
});

test("badge mapping: old names map to neutral ones", async () => {
  const { badgeName } = await import("../src/core/badge.ts");
  assert.equal(badgeName("approval"), "alert");
  assert.equal(badgeName("finished"), "done");
  assert.equal(badgeName("error"), "error");
  assert.equal(badgeName("done"), "done");
  assert.equal(badgeName(null), null);
});

test("mood alias map: old names map to neutral ones, new ones pass", async () => {
  const { moodName } = await import("../src/core/layout.ts");
  assert.deepEqual(
    ["approval", "question", "finished", "ratelimit"].map(moodName),
    ["alert", "ask", "done", "waiting"],
  );
  for (const m of ["idle", "working", "alert", "ask", "done", "waiting", "error"]) assert.equal(moodName(m), m);
});

test("sound alias: old names map to neutral ones", async () => {
  const { soundName, SOUND_NAMES } = await import("../src/core/sound.ts");
  assert.deepEqual(["approval", "question", "rate", "blip"].map(soundName), ["alert", "ask", "wait", "blip"]);
  for (const n of ["alert", "ask", "wait", "attach"]) assert.ok((SOUND_NAMES as readonly string[]).includes(n));
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
  assert.equal(homeOf({ view: "overview", pin: false, priority: 10 }, tabs), "overview");
  assert.equal(homeOf(null, tabs), "timer");
  assert.equal(homeOf(null, []), "empty");
});

test("homeOf: request > tab flagged home > first tab > empty", () => {
  const tabs = [{ view: "a" }, { view: "b", home: true as const }, { view: "c" }];
  assert.equal(homeOf({ view: "x", pin: false, priority: 1 }, tabs), "x");
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
