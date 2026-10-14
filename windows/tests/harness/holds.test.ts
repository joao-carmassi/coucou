// Task holds (api.island.hold) and ambient pills driven through the real island.
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
import { Holds } from "../../src/core/holds";
import { Compact } from "../../src/core/compact";

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
/** Reopen with no explicit target, as a click on the compact island does. */
const reopen = () => { island.fsm.forceHome(); tick(10); };
/** Hold `view`, open it, fold: the state a user leaves a task in. */
const leaveOn = (view: string) => { const off = a().island.hold(view); b().island.open(view); tick(10); folded(); return off; };

describe("task holds", () => {
  it("reopen lands on the held view; releasing goes home", () => {
    const off = leaveOn("dummy-b");
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    off();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("expires after the idle time; 0 turns it off", () => {
    const off = leaveOn("dummy-b");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    off();
    State.settings.focusHoldMinutes = 0;
    const off2 = leaveOn("dummy-b");
    reopen();
    expect(State.view).toBe(State.defaultView());
    State.settings.focusHoldMinutes = 10;
    folded();
    off2();
  });

  it("a pinned request beats the hold", () => {
    const off = leaveOn("dummy-b");
    const req = requestPin(b(), "dummy-a", 0, 10);
    reopen();
    expect(State.view).toBe("dummy-a");
    req();
    folded();
    off();
  });

  it("stopping the module drops its hold", () => {
    leaveOn("dummy-b");
    Registry.apply({ dummy: false, second: true });
    Registry.apply({ dummy: true, second: true });
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("two holds: the one seen last wins", () => {
    const o1 = a().island.hold("dummy-a");
    const o2 = a().island.hold("dummy-b");
    b().island.open("dummy-a"); tick(10);
    b().island.setView("dummy-b"); tick(10);
    b().island.setView("dummy-a"); tick(10);
    folded();
    reopen();
    expect(State.view).toBe("dummy-a");
    folded();
    o1(); o2();
    Holds.clear();
  });
});

describe("ambient pills", () => {
  it("stay listed, leave the grid, and do not hide the status line", () => {
    a().pills.set({ id: "dummy-quiet", label: "Q", color: "#222", ambient: true });
    expect(a().pills.others().map((p) => p.id)).toContain("dummy-quiet");
    expect(State.gridPills.map((p) => p.id)).not.toContain("dummy-quiet");
    expect(Compact.resolve(State.gridPills.length)?.text).toBe("dummy status");
    a().pills.remove("dummy-quiet");
  });
});
