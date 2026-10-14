// Behavioural neutrality: the island boots with only `clock` (dev module) + a Rust-less dummy module,
// and behaves. happy-dom does no layout, so geometry checks stay loose.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyProbe, requestPin } from "./dummyModule";

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
import { State } from "../../src/core/state";

type Engine = { triggerEmote(e: string): void };
const priv = (i: Island) => i as unknown as { engine: Engine; botCx: { value: number }; botCy: { value: number }; wasInIsland: boolean };

let island: Island;
let errors: ReturnType<typeof vi.spyOn>;
const tick = (ms: number) => vi.advanceTimersByTime(ms);

beforeAll(() => {
  vi.useFakeTimers();
  errors = vi.spyOn(console, "error");
  document.body.innerHTML = '<div id="root"></div>';
  // Same order as src/main.ts, minus the Tauri event wiring.
  island = new Island(document.getElementById("root")!);
  Registry.init(island);
  Registry.apply({ clock: true, dummy: true });
  island.launch();
});
afterAll(() => vi.useRealTimers());

describe("island with clock + dummy only", () => {
  it("runs past the greeting into compact", () => {
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe("greeting");
    tick(15_000);
    expect(State.mode).toBe("compact");
  });

  it("shows a status line in compact", () => {
    expect(document.querySelector("#activity-line")!.textContent).toContain("dummy status");
  });

  it("click opens the home tab; the header lists both modules' tabs", () => {
    const el = document.getElementById("island")!;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 360, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    // happy-dom lays nothing out: hover through the real cursor entry point.
    island.onCursor(360, 20);
    tick(100);
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe(State.tabs[0].view);
    expect(State.view).toBe("dummy-a");
    const titles = [...document.querySelectorAll("#header .tab")].map((b) => b.getAttribute("title"));
    expect(titles).toEqual(expect.arrayContaining(["Relógio", "dummy-a", "dummy-b"]));
  });

  it("api.avatar.emote reaches the engine", () => {
    const spy = vi.spyOn(priv(island).engine, "triggerEmote");
    dummyModuleApi().avatar.emote("wink");
    expect(spy).toHaveBeenCalledWith("wink");
    spy.mockRestore();
  });

  it("hovering the bot 1.9 s in expanded mode triggers the love emote and wakes the loop", () => {
    const p = priv(island);
    const spy = vi.spyOn(p.engine, "triggerEmote");
    const ensure = vi.spyOn(island, "ensureRunning");
    tick(7000); // lastLoveTime guard (6 s) and springs settle
    // Bot centre in window coordinates: island left edge + spring value (island rect via a hover far away first).
    island.onCursor(-500, -500);
    const w = (island as unknown as { width: { value: number } }).width.value;
    const cx = (720 - w) / 2 + p.botCx.value, cy = p.botCy.value;
    island.onCursor(cx, cy);
    ensure.mockClear();
    tick(1900);
    expect(spy).toHaveBeenCalledWith("love");
    expect(ensure).toHaveBeenCalled();
  });

  it("Registry.apply with no modules lands on the empty card without throwing", () => {
    expect(() => Registry.apply({ clock: false, dummy: false })).not.toThrow();
    tick(100);
    expect(State.tabs).toHaveLength(0);
    expect(State.view).toBe("empty");
  });

  it("logged no console.error", () => {
    expect(errors).not.toHaveBeenCalled();
  });

  it("never called a claude/github/voice/media/integrations command or event", () => {
    const names = [...calls.invoke.map((c) => c.cmd), ...calls.listen];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => /^(claude|github|voice|media|integrations)_/.test(n))).toEqual([]);
  });

  it("a module's pin request keeps the island open", () => {
    Registry.apply({ clock: true, dummy: true });
    requestPin(dummyProbe.api!, "dummy-b", 5000);
    tick(10);
    expect(State.view).toBe("dummy-b");
    expect(island.fsm.pinned).toBe(true);
  });
});

function dummyModuleApi() {
  return dummyProbe.api!;
}
