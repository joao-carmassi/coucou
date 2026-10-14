import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_MOODS, glowOf, moodOf, registerEmote, registerMood } from "../src/mochi/moods.ts";

// Golden copy of v0.5.0: BOT_STATES (engine.ts), botGlowColor (kit/palette.ts), botGlowOpacity (core/layout.ts), setState's entrance.
const GOLD_RGB = {
  idle: [0.902, 0.914, 0.933], working: [0.231, 0.62, 1], thinking: [0.545, 0.361, 0.965], searching: [0.388, 0.396, 0.949],
  alert: [0.961, 0.647, 0.141], ask: [0.133, 0.827, 0.933], error: [0.957, 0.314, 0.369], done: [0.204, 0.831, 0.6],
  waiting: [0.984, 0.573, 0.235], sleeping: [0.58, 0.635, 0.722], dizzy: [0.957, 0.447, 0.714],
} as const;
type Gold = { tint: number; eye: string; badge: string | null; motion: Record<string, unknown>; glow: string; glowOp: number; enter: string };
const GOLD: Record<string, Gold> = {
  idle: { tint: 0, eye: "pill", badge: null, motion: {}, glow: "#FFFFFF", glowOp: 0.15, enter: "blink" },
  working: { tint: 0.72, eye: "pill", badge: "dots", motion: {}, glow: "#3B9EFF", glowOp: 0.65, enter: "blink" },
  thinking: { tint: 0.72, eye: "pill", badge: "dots", motion: { look: [0.55, 0.55] }, glow: "#A78BFA", glowOp: 0.65, enter: "blink" },
  searching: { tint: 0.72, eye: "pill", badge: "dots", motion: { scans: true }, glow: "#6366F1", glowOp: 0.65, enter: "blink" },
  alert: { tint: 0.78, eye: "wide", badge: "bang", motion: { bounces: true }, glow: "#F5A524", glowOp: 0.65, enter: "hop" },
  ask: { tint: 0.75, eye: "pill", badge: "question", motion: { tilt: 0.17 }, glow: "#FFFFFF", glowOp: 0.65, enter: "blink" },
  error: { tint: 0.78, eye: "flat", badge: "dot", motion: {}, glow: "#F4505E", glowOp: 0.65, enter: "shake" },
  done: { tint: 0.35, eye: "happy", badge: "dot", motion: {}, glow: "#34D399", glowOp: 0.65, enter: "spark-roll" },
  waiting: { tint: 0.72, eye: "tired", badge: "dot", motion: { sweat: true }, glow: "#F59E0B", glowOp: 0.65, enter: "sweat" },
  sleeping: { tint: 0.32, eye: "closed", badge: null, motion: { breathes: true, zz: true }, glow: "#FFFFFF", glowOp: 0.15, enter: "blink" },
  dizzy: { tint: 0.7, eye: "spiral", badge: null, motion: {}, glow: "#FFFFFF", glowOp: 0, enter: "roll2" },
};
const byte = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);

test("the 11 built-in moods match v0.5.0 exactly (colours to the 8-bit step the canvas draws)", () => {
  assert.deepEqual(Object.keys(BUILTIN_MOODS).sort(), Object.keys(GOLD).sort());
  for (const [name, g] of Object.entries(GOLD)) {
    const m = moodOf(name);
    GOLD_RGB[name as keyof typeof GOLD_RGB].forEach((v, i) => assert.equal(byte(m.color, i), Math.round(v * 255), `${name} colour`));
    assert.equal(m.tint ?? 0.72, g.tint, `${name} tint`);
    assert.equal(m.eye, g.eye, `${name} eye`);
    assert.equal(m.badge?.kind ?? null, g.badge, `${name} badge`);
    assert.equal(m.badge?.color, undefined, `${name} badge follows the body colour`);
    assert.deepEqual(m.motion ?? {}, g.motion, `${name} motion`);
    assert.deepEqual(glowOf(name), { color: g.glow, opacity: g.glowOp }, `${name} glow`);
    assert.equal(m.enter ?? "blink", g.enter, `${name} entrance`);
    assert.equal(m.sound, undefined, `${name} has no sound`);
  }
});

test("moodOf: unknown names are idle; custom moods come and go with their disposer", () => {
  assert.equal(moodOf("nope.nothing"), BUILTIN_MOODS.idle);
  assert.equal(moodOf("constructor"), BUILTIN_MOODS.idle);
  const def = { color: "#112233", eye: "dot" as const };
  const off = registerMood("t.m", def);
  assert.equal(moodOf("t.m"), def);
  assert.deepEqual(glowOf("t.m"), { color: "#112233", opacity: 0.65 });
  off();
  assert.equal(moodOf("t.m"), BUILTIN_MOODS.idle);
  const off2 = registerEmote("t.e", { eye: "heart" });
  off2();
});
