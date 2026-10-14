// Modules' own moods, emotes and sounds, and the built-in entrances (engine spy).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe } from "./dummyModule";

vi.mock("../../src/modules/index", async () => {
  const { clockModule } = await import("../../src/modules/clock");
  const { dummyModule } = await import("./dummyModule");
  return { MODULES: [clockModule, dummyModule] };
});
vi.mock("../../src/modules/catalog", async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "clock", label: "Relógio", default: false, order: 100 },
      { id: "dummy", label: "Dummy", default: true, order: 200 },
    ], true),
  };
});

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Sound } from "../../src/core/sound";
import { BotEngine } from "../../src/mochi/engine";
import { BUILTIN_MOODS, moodOf, registerMood } from "../../src/mochi/moods";
import { createFreeBot } from "../../src/mochi/minibots";

type Priv = { engine: BotEngine };
let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const api = () => dummyProbe.api!;

beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island);
  Registry.apply({ clock: true, dummy: true });
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("clock's mood", () => {
  it("is defined by the clock, reaches the engine, and falls back to idle once the clock stops", () => {
    const m = moodOf("clock.tick");
    expect(m.enter).toBe("hop");
    expect(m).not.toBe(BUILTIN_MOODS.idle);
    api().avatar.publish({ state: "clock.tick", priority: 50 });
    tick(100);
    const engine = (island as unknown as Priv).engine;
    expect(engine.state).toBe("clock.tick");
    Registry.apply({ clock: false, dummy: true });
    expect(moodOf("clock.tick")).toBe(BUILTIN_MOODS.idle);
    tick(100);
    expect(engine.state).toBe("idle");
  });
});

describe("unknown moods never throw", () => {
  it("a free Mochi, an engine and a pill with a name nobody defined draw as idle", () => {
    expect(() => createFreeBot("#ff0000", "ghost.mood", 20)).not.toThrow();
    const { engine } = createFreeBot("#ff0000", "ghost.mood", 20);
    expect(engine.state).toBe("idle");
    expect(() => engine.setState("ghost.other")).not.toThrow();
    expect(engine.state).toBe("idle");
    expect(() => api().pills.set({ id: "g", label: "g", color: "#fff", mood: "ghost.mood" })).not.toThrow();
    tick(100);
    api().pills.remove("g");
  });
});

describe("custom emotes and sounds", () => {
  it("defineEmote returns its name and triggerEmote runs the generic path; stop removes it", () => {
    const name = api().avatar.defineEmote("cheer", { eye: "star", ms: 900, particles: { kind: "star", n: 3 }, blush: 0.5, motion: "hop", sound: "pop" });
    expect(name).toBe("dummy.cheer");
    const e = new BotEngine();
    const emit = vi.spyOn(e, "emit");
    const play = vi.spyOn(Sound, "play").mockImplementation(() => {});
    e.triggerEmote(name);
    expect(e.eyeOverride).toBe("star");
    expect(emit).toHaveBeenCalledWith("star", 3);
    expect(play).toHaveBeenCalledWith("pop");
    expect(e.animating).toBe(true);
    play.mockRestore();
    Registry.apply({ clock: false, dummy: false });
    const e2 = new BotEngine();
    e2.triggerEmote(name);
    expect(e2.eyeOverride).toBeNull();
  });
});

describe("built-in entrances are unchanged", () => {
  // What v0.5.0 setState did per mood: tweened props (badge fade aside), doRoll args, particles.
  const BLINK = { anim: ["open"], roll: [], emit: [] };
  const EXPECT: Record<string, { anim: string[]; roll: number[][]; emit: unknown[][] }> = {
    idle: BLINK, working: BLINK, thinking: BLINK, searching: BLINK, sleeping: BLINK, ask: BLINK,
    done: { anim: ["roll"], roll: [[950, 1]], emit: [] },
    dizzy: { anim: ["roll"], roll: [[1300, 2]], emit: [] },
    error: { anim: ["ox"], roll: [], emit: [] },
    alert: { anim: ["oy"], roll: [], emit: [] },
    waiting: { anim: [], roll: [], emit: [["sweat", 1]] },
  };
  for (const [mood, want] of Object.entries(EXPECT)) {
    it(mood, () => {
      const e = new BotEngine();
      if (mood === "idle") e.setState("working", true); // idle -> idle does not blink
      const anim = vi.spyOn(e as never, "anim");
      const roll = vi.spyOn(e, "doRoll");
      const emit = vi.spyOn(e, "emit");
      const blink = vi.spyOn(e, "blink");
      e.setState(mood as never, true);
      expect(blink).toHaveBeenCalledTimes(want === BLINK ? 1 : 0); // the open tween may still be locked by an earlier blink
      if (mood !== "idle") expect((anim.mock.calls as unknown[][]).map((c) => c[0]).filter((p) => p !== "badgeS")).toEqual(want.anim);
      expect(roll.mock.calls).toEqual(want.roll);
      expect(emit.mock.calls).toEqual(want.emit);
    });
  }
  it("done adds five sparks after 500 ms", () => {
    const e = new BotEngine();
    const emit = vi.spyOn(e, "emit");
    e.setState("done");
    expect(emit).not.toHaveBeenCalled();
    tick(500);
    expect(emit).toHaveBeenCalledWith("spark", 5);
  });
});

describe("emote numbers are clamped", () => {
  it("particles 0..12, ms 100..10000, blush 0..1", () => {
    Registry.apply({ clock: false, dummy: true });
    const name = api().avatar.defineEmote("wild", { eye: "star", ms: 99_999_999, particles: { kind: "heart", n: 5000 }, blush: 40 });
    const e = new BotEngine();
    const emit = vi.spyOn(e, "emit");
    const anim = vi.spyOn(e as never, "anim");
    e.triggerEmote(name);
    expect(emit).toHaveBeenCalledWith("heart", 12);
    expect(e.eyeOverrideUntil - performance.now() / 1000).toBeLessThanOrEqual(10.001);
    expect((anim.mock.calls[0] as unknown[][])[1]).toEqual([[1, 250, expect.anything()], [1, 9500, expect.anything()], [0, 300, expect.anything()]]);
    const low = api().avatar.defineEmote("tiny", { eye: "dot", ms: 1, particles: { kind: "z", n: -3 } });
    const e2 = new BotEngine();
    const emit2 = vi.spyOn(e2, "emit");
    e2.triggerEmote(low);
    expect(emit2).toHaveBeenCalledWith("z", 0);
    expect(e2.eyeOverrideUntil - performance.now() / 1000).toBeGreaterThan(0.09);
    expect(e2.eyeOverrideUntil - performance.now() / 1000).toBeLessThanOrEqual(0.101);
  });
});

describe("defineMood validates colours", () => {
  it("throws naming the module for a bad body, badge or glow colour", () => {
    Registry.apply({ clock: false, dummy: true });
    const d = api().avatar.defineMood;
    expect(() => d("x", { color: "red", eye: "dot" })).toThrow(/module "dummy".*color/);
    expect(() => d("x", { color: "#abc", eye: "dot" })).toThrow(/#RRGGBB/);
    expect(() => d("x", { color: "#112233", eye: "dot", badge: { kind: "dot", color: "nope" } })).toThrow(/badge\.color/);
    expect(() => d("x", { color: "#112233", eye: "dot", glow: { color: "#12345", opacity: 1 } })).toThrow(/glow\.color/);
    expect(d("ok", { color: "#AbCdEf", eye: "dot" })).toBe("dummy.ok");
  });
});

describe("live sprites follow the mood registry", () => {
  it("a removed mood falls back to idle on the next frame; a redefine is picked up", () => {
    const off = registerMood("t.live", { color: "#112233", eye: "dot" });
    const e = new BotEngine();
    e.setState("t.live");
    expect((e as unknown as { cfg: { eye: string } }).cfg.eye).toBe("dot");
    registerMood("t.live", { color: "#445566", eye: "wide" });
    e.update(0.016);
    expect(e.state).toBe("t.live");
    expect((e as unknown as { cfg: { eye: string } }).cfg.eye).toBe("wide");
    off(); // the first definition is already replaced: removing it changes nothing
    e.update(0.016);
    expect(e.state).toBe("t.live");
    const off2 = registerMood("t.live", { color: "#778899", eye: "line" });
    off2();
    e.update(0.016);
    expect(e.state).toBe("idle");
  });
});
