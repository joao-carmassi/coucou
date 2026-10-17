import { describe, expect, test, vi } from "vitest";
import "./setup";
import { colorFor } from "../../src/core/pills";
import { BotEngine, bodyShade, glanceOffset, levelAt, sleepDue, LEVEL_DECAY_MS } from "../../src/mochi/engine";
import { greetingLine } from "../../src/mochi/greeting";

describe("colorFor", () => {
  const m = { integration_a: "#112233", "integration_*": "#445566", "integ*": "#778899", bad: "red", "x*": "nope" };
  test("exact > longest prefix > own", () => {
    expect(colorFor(m, "integration_a", "#000000")).toBe("#112233");
    expect(colorFor(m, "integration_b", "#000000")).toBe("#445566");
    expect(colorFor(m, "integx", "#000000")).toBe("#778899");
    expect(colorFor(m, "other", "#000000")).toBe("#000000");
    expect(colorFor(m, "bad", "#000000")).toBe("#000000");
    expect(colorFor(m, "xy", "#abcdef")).toBe("#abcdef");
    expect(colorFor(undefined, "a", "#abcdef")).toBe("#abcdef");
  });
});

describe("bodyShade", () => {
  test("top lighter, bottom darker, ink by luminance", () => {
    const s = bodyShade([0.5, 0.2, 0.2]);
    expect(s.top[0]).toBeGreaterThan(s.bottom[0]);
    expect(bodyShade([0.05, 0.05, 0.1]).ink).toContain("246");
    expect(bodyShade([0.95, 0.95, 0.9]).ink).toContain("26,20,18");
  });
});

describe("level and rest", () => {
  test("decay", () => {
    expect(levelAt(1, 0, 0)).toBe(1);
    expect(levelAt(1, 0, LEVEL_DECAY_MS / 2)).toBeCloseTo(0.5);
    expect(levelAt(1, 0, LEVEL_DECAY_MS * 2)).toBe(0);
  });
  test("throttle drops calls under 33 ms; zero always lands", () => {
    const e = new BotEngine();
    expect(e.setLevel(0.5, 1000)).toBe(true);
    expect(e.setLevel(0.6, 1010)).toBe(false);
    expect(e.setLevel(0.6, 1040)).toBe(true);
    expect(e.setLevel(0, 1041)).toBe(true);
  });
  test("sleepDue", () => {
    expect(sleepDue(0, 600_000, 10)).toBe(true);
    expect(sleepDue(0, 599_000, 10)).toBe(false);
    expect(sleepDue(0, 1e12, 0)).toBe(false);
  });
  test("hidden island + level calls request no frame", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { Island } = await import("../../src/island/island");
    const { State } = await import("../../src/core/state");
    State.mode = "hidden";
    const isl = Object.create(Island.prototype) as { avatarLevel(v: number): void; engine: BotEngine; link: { on: boolean } };
    isl.engine = new BotEngine();
    isl.link = { on: false };
    raf.mockClear();
    for (let i = 0; i < 5; i++) isl.avatarLevel(0.8);
    expect(raf).not.toHaveBeenCalled();
  });
});

test("glanceOffset only idle and inside window", () => {
  expect(glanceOffset("idle", 1, 2, 0.4)).toBe(0.4);
  expect(glanceOffset("idle", 3, 2, 0.4)).toBe(0);
  expect(glanceOffset("sleeping", 1, 2, 0.4)).toBe(0);
});

test("greetingLine", () => {
  expect(greetingLine(9, 0)).toBe("Bom dia");
  expect(greetingLine(20, 2)).toBe("Boa noite · 2 avisos");
});
