// Task holds (api.island.hold) and ambient pills driven through the real island.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe, requestPin } from "./dummyModule";
import { BAND, type IslandApi, type ModuleDef } from "../../src/core/moduleApi";

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
import { Holds, Last } from "../../src/core/holds";
import { compactWidth } from "../../src/core/layout";

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
/** Visit `view` with the island open, then fold it: the state a user leaves a tab in. */
const visit = (view: string) => { b().island.open(view); tick(10); folded(); };
const MIN = 60_000;
const lastHome = () => { Holds.clear(); Last.clear(); };

describe("implicit focus (no hold call)", () => {
  it("reopen within the focus time lands on the last tab; after it, home", () => {
    visit("dummy-b");
    tick(59_000);
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    vi.setSystemTime(Date.now() + 61_000);
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("the time counts from the close, not from the tab switch", () => {
    b().island.open("dummy-b"); tick(10);
    vi.setSystemTime(Date.now() + 50_000); // a long visit, still open
    folded();
    vi.setSystemTime(Date.now() + 30_000);
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    lastHome();
  });

  it("A -> B -> close -> reopen lands on B", () => {
    b().island.open("dummy-b"); tick(10);
    b().island.setView("dummy-a"); tick(10);
    b().island.setView("dummy-b"); tick(10);
    folded();
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    lastHome();
  });

  it("a tiny focus time turns it off; unknown view skipped; a home visit lands home", () => {
    State.settings.compactHideInterval = 0.001;
    visit("dummy-b");
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    State.settings.compactHideInterval = 60;
    visit(State.defaultView());
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    lastHome();
  });

  it("a pinned request beats it", () => {
    visit("dummy-b");
    const req = requestPin(b(), "dummy-a", 0, 10);
    reopen();
    expect(State.view).toBe("dummy-a");
    req();
    folded();
    lastHome();
  });
});

describe("cards that are not tabs are never the focus", () => {
  it("closing on a card reopens on the previous tab, counted from the close", () => {
    lastHome();
    b().island.open("dummy-b"); tick(10);
    a().island.note("card"); tick(10);
    expect(State.view).toBe("note");
    vi.setSystemTime(Date.now() + 50_000); // the card stays up, then the island closes
    folded();
    vi.setSystemTime(Date.now() + 30_000);
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    lastHome();
  });

  it("nothing recorded: a card alone reopens home, not on the dead card", () => {
    lastHome();
    a().island.note("card"); tick(10);
    expect(State.view).toBe("note");
    folded();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    lastHome();
  });
});

describe("sticky holds", () => {
  it("land on the held view after any time; releasing goes home", () => {
    const off = a().island.hold("dummy-b");
    visit("dummy-a");
    vi.setSystemTime(Date.now() + 10 * 60_000);
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    off();
    Last.clear();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    lastHome();
  });

  it("beat the implicit last view", () => {
    const off = a().island.hold("dummy-b");
    visit("dummy-a");
    b().island.open("dummy-a"); tick(10); folded();
    reopen();
    expect(State.view).toBe("dummy-b");
    folded();
    off();
    lastHome();
  });

  it("idleMs still expires", () => {
    const off = a().island.hold("dummy-b", { idleMs: 1000 });
    visit("dummy-a");
    vi.setSystemTime(Date.now() + 5000);
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    off();
    lastHome();
  });

  it("stopping the module drops its hold", () => {
    a().island.hold("dummy-b");
    visit("dummy-a");
    Registry.apply({ dummy: false, second: true });
    Registry.apply({ dummy: true, second: true });
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    lastHome();
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
    lastHome();
  });

  it("the home tab clears holds and the implicit focus", () => {
    a().island.hold("dummy-b");
    b().island.open("dummy-b"); tick(10);
    const home = State.tabs.find((t) => t.view === State.defaultView())!;
    [...document.querySelectorAll<HTMLElement>("#header .tabs button")].find((x) => x.title === home.title || x.textContent === home.title)!.click();
    tick(10);
    // Right after the click, before any close re-stamps the view left: nothing is remembered.
    expect(Last.front(Date.now(), MIN, "none", () => true)).toBeNull();
    folded(); reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    lastHome();
  });
});

describe("ambient pills", () => {
  const ids = () => State.gridPills.map((p) => p.id);
  const width = () => (island as unknown as { targetSize(): { w: number } }).targetSize().w;
  const add = () => {
    b().pills.set({ id: "second-quiet", label: "Q", color: "#222", ambient: true });
    b().pills.set({ id: "second-loud", label: "L", color: "#444", mood: "done", badge: "done" });
  };
  const drop = () => { b().pills.remove("second-quiet"); b().pills.remove("second-loud"); };

  it("stay listed, leave the grid, and do not hide the status line", () => {
    a().pills.set({ id: "dummy-quiet", label: "Q", color: "#222", ambient: true });
    expect(a().pills.others().map((p) => p.id)).toContain("dummy-quiet");
    expect(State.gridPills.map((p) => p.id)).not.toContain("dummy-quiet");
    expect(State.statusLine?.text).toBe("dummy status");
    a().pills.remove("dummy-quiet");
  });

  it("a status line on show hides the ambient pills; only the ones with news compete", () => {
    b().pills.set({ id: "second-quiet", label: "Q", color: "#222", ambient: true });
    expect(ids()).toEqual([]);
    b().pills.set({ id: "second-loud", label: "L", color: "#444", mood: "done", badge: "done" });
    expect(State.statusLine).toBeNull(); // a pill with news takes the grid, so the line steps aside
    expect(ids()).toEqual(["second-quiet", "second-loud"]);
    drop();
  });

  it("nobody working: every pill shows again, ambient ones included, and the width follows", () => {
    a().status.set(null);
    add();
    expect(ids()).toEqual(["second-quiet", "second-loud"]);
    expect(width()).toBe(compactWidth(2, 0));
    b().pills.remove("second-loud");
    expect(ids()).toEqual(["second-quiet"]);
    expect(width()).toBe(compactWidth(1, 0));
    a().status.set({ priority: BAND.ACTIVE, text: "dummy status" });
    expect(ids()).toEqual([]);
    drop();
  });

  it("an overGrid line hides the grid whatever the pills", () => {
    a().status.set({ priority: BAND.URGENT, text: "timer", overGrid: true });
    add();
    expect(State.statusLine?.text).toBe("timer");
    expect(ids()).toEqual(["second-loud"]);
    drop();
    a().status.set({ priority: BAND.ACTIVE, text: "dummy status" });
  });
});
