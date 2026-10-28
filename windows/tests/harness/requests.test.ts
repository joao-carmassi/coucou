// The core-owned request queue (api.island.request) driven through the real island.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe, requestPin } from "./dummyModule";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";

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
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const a = () => dummyProbe.api!;
const b = () => second.api!;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, second: true });
  island.launch();
  tick(15_000); // greeting -> compact
});
afterAll(() => vi.useRealTimers());

const folded = () => { island.collapse(); tick(10); };

describe("request queue", () => {
  it("(a) two modules pin; disposing one does not unpin the other", () => {
    const da = requestPin(a(), "dummy-a", 0, 10);
    const db = requestPin(b(), "dummy-b", 0, 20);
    tick(10);
    expect(State.mode).toBe("expanded");
    expect(State.isPinned).toBe(true);
    da();
    expect(State.isPinned).toBe(true);
    expect(island.fsm.pinned).toBe(true);
    db();
    expect(State.isPinned).toBe(false);
    expect(island.fsm.pinned).toBe(false);
    folded();
  });

  it("(b) a lower-priority request does not steal the view; (c) the front going shows the next", () => {
    const high = requestPin(a(), "dummy-b", 0, 50);
    tick(10);
    expect(State.view).toBe("dummy-b");
    const low = requestPin(b(), "dummy-a", 0, 5);
    tick(10);
    expect(State.view).toBe("dummy-b");
    high();
    tick(10);
    expect(State.view).toBe("dummy-a");
    expect(State.isPinned).toBe(true);
    low();
    expect(State.isPinned).toBe(false);
    folded();
  });

  it("(d) ms disposes the request by itself", () => {
    requestPin(a(), "dummy-a", 5000);
    tick(10);
    expect(State.isPinned).toBe(true);
    tick(5000);
    expect(State.isPinned).toBe(false);
    expect(island.fsm.pinned).toBe(false);
    folded();
  });

  it("(e) stopping a module disposes its requests, and only those", () => {
    requestPin(a(), "dummy-a", 0, 10);
    requestPin(b(), "dummy-b", 0, 20);
    tick(10);
    Registry.apply({ dummy: true, second: false });
    expect(State.isPinned).toBe(true); // dummy's is still there
    expect(State.view).toBe("dummy-a");
    Registry.apply({ dummy: false, second: false });
    expect(State.isPinned).toBe(false);
    Registry.apply({ dummy: true, second: true });
    folded();
  });

  it("a pinned island ignores Esc and the auto-close; unpinned it collapses", () => {
    const off = requestPin(a(), "dummy-a", 0, 10);
    tick(10);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    tick(60_000);
    expect(State.mode).toBe("expanded");
    off();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    tick(10);
    expect(State.mode).toBe("compact");
  });

  it("re-requesting the same card (voice phases) keeps the island open", () => {
    let off = requestPin(a(), "dummy-a", 0, 40);
    tick(10);
    for (let i = 0; i < 3; i++) {
      const prev = off;
      off = requestPin(a(), "dummy-a", 0, 40);
      prev();
      tick(30_000);
      expect(State.mode).toBe("expanded");
      expect(State.isPinned).toBe(true);
    }
    off();
    folded();
  });

  it("'Aguardar': close keeps the request; hover on the hidden island reopens it pinned", async () => {
    const off = requestPin(a(), "dummy-b", 0, 90);
    tick(10);
    island.collapse();
    tick(10);
    expect(State.mode).toBe("compact");
    expect(State.isPinned).toBe(false);
    island.hide();
    tick(10);
    expect(State.mode).toBe("hidden");
    document.querySelector("#wake-strip, .wake-strip")?.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(10); // the strip asks the OS about full screen first
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe("dummy-b");
    expect(State.isPinned).toBe(true);
    off();
    folded();
  });

  it("MED1: a parked request does not pin an unrelated view opened later", () => {
    const off = requestPin(a(), "dummy-b", 0, 90);
    tick(10);
    island.collapse();
    tick(10);
    expect(State.isPinned).toBe(false);
    b().island.open("dummy-a"); // tray / news / upload style navigation
    tick(10);
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe("dummy-a");
    expect(State.isPinned).toBe(false);
    tick(60_000);
    expect(State.mode).not.toBe("expanded"); // auto-close still works
    off();
    folded();
  });

  it("MED2: dropping the on-screen card behind the front switches to the front's view", () => {
    const front = requestPin(a(), "dummy-b", 0, 90);
    tick(10);
    const quietOn = b().island.request({ view: "dummy-a", priority: 10, pin: true });
    expect(State.view).toBe("dummy-b");
    b().island.setView("dummy-a"); // the lower card is what the screen shows
    tick(10);
    expect(State.view).toBe("dummy-a");
    quietOn();
    tick(10);
    expect(State.view).toBe("dummy-b");
    front();
    folded();
  });

  it("LOW4: open() while already home with the mouse outside starts the auto-close countdown", () => {
    b().island.open("dummy-a");
    tick(10);
    b().island.open("dummy-b"); // already home: no transition runs
    tick(60_000);
    expect(State.mode).not.toBe("expanded");
    folded();
  });

  it("busy() is true while a pinned request exists", () => {
    expect(a().island.busy()).toBe(false);
    const off = requestPin(b(), "dummy-a", 0, 1);
    expect(a().island.busy()).toBe(true);
    off();
    expect(a().island.busy()).toBe(false);
  });
});
