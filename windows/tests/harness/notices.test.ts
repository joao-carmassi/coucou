// api.island.notice + presence, driven through the real island.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyProbe } from "./dummyModule";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";

// What the OS says when the watch is turned on (the Rust command answers with the current state).
const os = vi.hoisted(() => ({ quiet: false }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    return cmd === "presence_watch" && (args as { on: boolean }).on ? { quiet: os.quiet, mic: false } : null;
  },
}));

const { second, secondModule } = vi.hoisted(() => {
  const second: { api: IslandApi | null } = { api: null };
  const secondModule = { id: "second", start(api: IslandApi) { second.api = api; return () => { second.api = null; }; } } as ModuleDef;
  return { second, secondModule };
});

const loadModules = async () => {
  const { dummyModule } = await import("./dummyModule");
  return { MODULES: [dummyModule, secondModule] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "dummy", label: "Dummy", default: true, order: 200 },
      { id: "second", label: "Second", default: true, order: 210 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const a = () => dummyProbe.api!;
const b = () => second.api!;
const text = () => State.statusLine?.text ?? null;
const watches = () => calls.invoke.filter((c) => c.cmd === "presence_watch").map((c) => (c.args as { on: boolean }).on);
/** The OS state changes (an event while watching). */
const quiet = (q: boolean) => {
  os.quiet = q;
  island.applyPresence({ quiet: q, mic: false });
};
/** Back to a compact, not quiet island with an empty queue. */
const reset = async () => {
  State.settings.hideWhenBusy = true;
  Registry.apply({ dummy: true, second: false }); // a stopped module takes its notices with it
  Registry.apply({ dummy: true, second: true });
  quiet(false);
  island.hide();
  await tick(10);
  island.reveal();
  await tick(500);
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<div id=\"root\"></div>";
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, second: true });
  island.launch();
  await tick(15_000); // greeting -> compact
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  State.setPaused(false);
  await reset();
});

describe("notices", () => {
  it("shows when compact, then goes after its time", async () => {
    expect(State.mode).toBe("compact");
    b().island.notice({ text: "olá", ms: 2000 });
    await tick(100);
    expect(text()).toBe("olá");
    await tick(1500);
    expect(text()).toBe("olá");
    await tick(700);
    expect(text()).toBe("dummy status");
  });

  it("a status line at 100 hides a notice at 60; it shows once the line goes", async () => {
    a().status.set({ priority: 100, text: "pinned", overGrid: true });
    await tick(50);
    b().island.notice({ text: "burst", priority: 60 });
    await tick(5000); // would have ended had the clock run
    expect(text()).toBe("pinned");
    a().status.set(null);
    await tick(50);
    expect(text()).toBe("burst");
    await tick(4100);
    expect(text()).not.toBe("burst");
    a().status.set({ priority: 30, text: "dummy status" });
  });

  it("hidden + peek reveals the compact island; without peek it waits", async () => {
    island.hide();
    await tick(500);
    expect(State.mode).toBe("hidden");
    const off = b().island.notice({ text: "no peek" });
    await tick(100);
    expect(State.mode).toBe("hidden");
    off();
    b().island.notice({ text: "peeker", peek: true });
    await tick(100);
    expect(State.mode).toBe("compact");
    expect(text()).toBe("peeker");
  });

  it("quiet holds a 60 and still shows a 90; a change into quiet folds the island", async () => {
    quiet(true);
    await tick(500);
    expect(State.mode).toBe("hidden");
    b().island.notice({ text: "plain", priority: 60, peek: true });
    await tick(100);
    expect(State.mode).toBe("hidden");
    b().island.notice({ text: "urgent", priority: 90, peek: true });
    await tick(100);
    expect(State.mode).toBe("compact");
    expect(text()).toBe("urgent");
    await tick(4200);
    expect(text()).not.toBe("plain");
    quiet(false);
    await tick(100);
    expect(text()).toBe("plain");
  });

  it("hideWhenBusy off: quiet changes nothing", async () => {
    State.settings.hideWhenBusy = false;
    island.applySettings();
    quiet(true);
    await tick(100);
    expect(State.mode).toBe("compact");
    b().island.notice({ text: "still shows" });
    await tick(100);
    expect(text()).toBe("still shows");
    State.settings.hideWhenBusy = true;
    island.applySettings();
  });

  it("paused: a no-op disposer, nothing queued", async () => {
    State.setPaused(true);
    const off = b().island.notice({ text: "paused one" });
    await tick(100);
    expect(text()).not.toBe("paused one");
    expect(() => off()).not.toThrow();
  });

  it("the module stopping clears its notices", async () => {
    b().island.notice({ text: "going", ms: 15_000 });
    await tick(100);
    expect(text()).toBe("going");
    Registry.apply({ dummy: true, second: false });
    await tick(100);
    expect(text()).not.toBe("going");
    Registry.apply({ dummy: true, second: true });
  });

  it("a click while shown opens its view and consumes it", async () => {
    b().island.notice({ text: "abre", view: "dummy-b", ms: 15_000 });
    await tick(100);
    expect(text()).toBe("abre");
    island.fsm.click();
    await tick(100);
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe("dummy-b");
    island.collapse();
    await tick(500);
    expect(text()).not.toBe("abre");
  });

  it("no timeout is left once the queue is empty", async () => {
    const before = vi.getTimerCount();
    b().island.notice({ text: "temp", ms: 1500 });
    await tick(100);
    expect(vi.getTimerCount()).toBeGreaterThan(before);
    await tick(2000);
    expect(text()).not.toBe("temp");
    expect(vi.getTimerCount()).toBe(before);
  });

  it("presence is watched only while it matters: a true/false pair", async () => {
    island.hide();
    await tick(500);
    const n = watches().length;
    expect(watches()[n - 1]).toBe(false);
    const off = b().island.notice({ text: "waits" });
    expect(watches().slice(n)).toEqual([true]);
    off();
    expect(watches().slice(n)).toEqual([true, false]);
  });

  it("nothing is watched with the setting off", async () => {
    State.settings.hideWhenBusy = false;
    island.applySettings();
    const n = watches().length;
    const off = b().island.notice({ text: "x" });
    off();
    expect(watches().slice(n)).toEqual([]);
    State.settings.hideWhenBusy = true;
    island.applySettings();
  });
});
