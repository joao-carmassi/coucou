// The island side of the companion: nothing sent while off; one message per state change while on; no Mochi drawn by the island.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { State } from "../../src/core/state";
import { Island } from "../../src/island/island";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const sent = () => calls.emit.filter((e) => e.event === "companion-avatar");
const canvasOpacity = () => (island as unknown as { botCanvas: HTMLCanvasElement }).botCanvas.style.opacity;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<div id=\"root\"></div>";
  island = new Island(document.getElementById("root")!);
  island.launch();
  await tick(5_000);
});
afterAll(() => vi.useRealTimers());

describe("companion link", () => {
  it("off: no companion-avatar message, whatever the island does", async () => {
    calls.emit.length = 0;
    State.stateOverride = "working";
    State.notify();
    await tick(2_000);
    State.stateOverride = null;
    State.notify();
    await tick(2_000);
    expect(sent()).toHaveLength(0);
  });

  it("on: one message when it comes on, one per state change, none per frame; the island draws no Mochi", async () => {
    calls.emit.length = 0;
    State.settings.companionEnabled = true;
    island.applySettings();
    await tick(3_000); // many frames
    expect(sent()).toHaveLength(1);
    expect(sent()[0].payload).toMatchObject({ state: "idle", hidden: false });
    expect(canvasOpacity()).toBe("0");

    State.stateOverride = "working";
    State.notify();
    await tick(3_000);
    expect(sent()).toHaveLength(2);
    expect(sent()[1].payload).toMatchObject({ state: "working" });

    // pausing hides the companion
    State.setPaused(true);
    await tick(500);
    expect(sent()).toHaveLength(3);
    expect(sent()[2].payload).toMatchObject({ hidden: true });
    State.setPaused(false);
  });

  it("off again: the island draws his Mochi again and sends nothing", async () => {
    State.stateOverride = null;
    State.settings.companionEnabled = false;
    island.applySettings();
    await tick(1_000);
    calls.emit.length = 0;
    State.notify();
    await tick(2_000);
    expect(sent()).toHaveLength(0);
    expect(canvasOpacity()).toBe("1");
  });
});
