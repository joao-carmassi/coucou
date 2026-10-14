// The home's primary: a default (setting boardPrimary), a click on a pill that lasts the focus time, and the
// revert on the next open, and by one timeout armed only while a pick exists and the island is folded. Providers are Rust-less dummies; their pills are `<id>-pill`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";
import type { BoardCardOf, BoardFocus } from "../../src/modules/board/api";

const probe: Record<string, IslandApi | null> = {};

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const provider = (id: string, label: string): ModuleDef => ({
    id,
    start(api) {
      probe[id] = api;
      api.pills.set({ id: `${id}-pill`, label, color: "#88aaff", mood: "idle" });
      const offs = [
        api.provide<BoardCardOf>("board.card", (tid) => tid !== `${id}-pill` ? null : {
          key: id, build: () => Object.assign(document.createElement("div"), { className: "tile-card", textContent: `card of ${label}` }),
        }),
        api.provide<BoardFocus>("board.focus", (tid) => { if (tid === `${id}-pill`) api.pills.focus(tid); }),
      ];
      return () => { offs.forEach((o) => o()); probe[id] = null; };
    },
  } as ModuleDef);
  return { MODULES: [board, provider("claude", "Claude"), provider("alpha", "Alpha"), provider("vercel", "Vercel")] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  const manifest = (await import("../../src/modules/board/manifest.json")).default;
  return {
    MODULE_INFO: buildCatalog([
      manifest,
      { id: "claude", label: "Claude", default: true, order: 1 },
      { id: "alpha", label: "Alpha", default: true, order: 2 },
      { id: "vercel", label: "Vercel", default: true, order: 3 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const ALL = { board: true, claude: true, alpha: true, vercel: true };
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const set = (patch: Record<string, unknown>) => Object.assign(State.settings, patch);
const front = () => State.focusPill?.id;
const fold = () => { island.collapse(); tick(10); };
const reopen = () => { island.fsm.forceHome(); tick(100); };
const clickPill = (label: string) => {
  [...document.querySelectorAll<HTMLElement>(".pill")].find((p) => p.textContent === label)!.click();
  tick(100);
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply(ALL);
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  Registry.apply({ ...ALL, board: false }); // a fresh board: no pick or close time from the last test
  Registry.apply(ALL);
  set({ boardPrimary: "claude", focusHoldMinutes: 1 });
  for (const [id, label] of [["claude", "Claude"], ["alpha", "Alpha"], ["vercel", "Vercel"]]) probe[id]!.pills.set({ id: `${id}-pill`, label, color: "#88aaff", mood: "idle" }); // nothing leaks between tests
  probe.vercel!.pills.focus("vercel-pill"); // not the default: the default has to be applied
  fold();
  vi.setSystemTime(new Date(2030, 0, 1));
});

describe("board primary", () => {
  it("claude is the default, as before", () => {
    reopen();
    expect(front()).toBe("claude-pill");
    expect(document.body.textContent).toContain("card of Claude");
  });

  it("the setting picks the default primary on the next open", () => {
    set({ boardPrimary: "alpha" });
    reopen();
    expect(front()).toBe("alpha-pill");
    expect(document.body.textContent).toContain("card of Alpha");
  });

  it("a default that is not running changes nothing", () => {
    set({ boardPrimary: "ghost" });
    reopen();
    expect(front()).toBe("vercel-pill");
  });

  it("a click on a pill makes it the primary", () => {
    reopen();

    clickPill("Vercel");
    expect(front()).toBe("vercel-pill");
    expect(document.body.textContent).toContain("card of Vercel");
  });

  it("before the focus time it stays; after it, the next open is back on the default", () => {
    reopen();
    clickPill("Vercel");
    fold();
    vi.setSystemTime(Date.now() + 30_000);
    reopen();
    expect(front()).toBe("vercel-pill");
    fold();
    vi.setSystemTime(Date.now() + 61_000);
    reopen();
    expect(front()).toBe("claude-pill");
  });

  it("time spent open does not count; only time since it closed", () => {
    reopen();
    clickPill("Vercel");
    vi.setSystemTime(Date.now() + 10 * 60_000);
    fold();
    reopen();
    expect(front()).toBe("vercel-pill");
  });

  it("0 minutes: back to the default at once", () => {
    set({ focusHoldMinutes: 0 });
    reopen();
    clickPill("Vercel");
    fold();
    reopen();
    expect(front()).toBe("claude-pill");
  });

  it("the provider being switched off falls back to the default", () => {
    set({ boardPrimary: "alpha" });
    reopen();
    clickPill("Vercel");
    Registry.apply({ ...ALL, vercel: false });
    tick(100);
    expect(front()).toBe("alpha-pill");
  });

  it("news that takes the front ends the pick and wins over the default", () => {
    reopen();
    clickPill("Vercel");
    probe.alpha!.pills.set({ id: "alpha-pill", mood: "done" });
    probe.alpha!.pills.focus("alpha-pill");
    fold();
    reopen();
    expect(front()).toBe("alpha-pill");
  });

  it("an error or alert on the front keeps it over the default", () => {
    set({ boardPrimary: "alpha" });
    probe.claude!.pills.set({ id: "claude-pill", mood: "error" });
    probe.claude!.pills.focus("claude-pill");
    fold();
    reopen();
    expect(front()).toBe("claude-pill");
    probe.claude!.pills.set({ id: "claude-pill", mood: "idle" });
  });

  it("the board stopping leaves nothing behind: a click after stop picks nothing and nothing reverts", async () => {
    reopen();
    const vercel = [...document.querySelectorAll<HTMLElement>(".pill")].find((p) => p.textContent === "Vercel")!;
    const { rt } = await import("../../src/modules/board/primary");
    expect(rt.choose).toBeTypeOf("function");
    Registry.apply({ ...ALL, board: false });
    expect(rt.choose).toBeNull(); // nothing records a pick any more
    vercel.click(); // a stale handler
    tick(10);
    expect(front()).toBe("vercel-pill");
    fold();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    reopen();
    tick(1000);
    expect(front()).toBe("vercel-pill");
    Registry.apply(ALL);
  });
});

describe("board primary: a folded island reverts the pick", () => {
  it("pick, fold, focus time passes without reopening: the default is in front and the island stays folded", () => {
    reopen();
    clickPill("Vercel");
    fold();
    tick(30_000);
    expect(front()).toBe("vercel-pill");
    tick(31_000);
    expect(front()).toBe("claude-pill");
    expect(State.mode).not.toBe("expanded");
  });

  it("0 minutes reverts at the fold", () => {
    set({ focusHoldMinutes: 0 });
    reopen();
    clickPill("Vercel");
    fold();
    tick(10);
    expect(front()).toBe("claude-pill");
  });

  it("reopening before the time cancels the timer", () => {
    reopen();
    clickPill("Vercel");
    fold();
    tick(30_000);
    reopen();
    const off = probe.alpha!.island.request({ view: "home", priority: 10, pin: true }); // keeps it open past the old deadline
    tick(120_000);
    expect(State.mode).toBe("expanded");
    expect(front()).toBe("vercel-pill");
    off();
  });

  it("the board stopping clears the timer", () => {
    reopen();
    clickPill("Vercel");
    fold();
    Registry.apply({ ...ALL, board: false });
    tick(120_000);
    expect(front()).toBe("vercel-pill");
    Registry.apply(ALL);
  });

  it("something else took the front after the pick: the fold revert does not force the default over it", () => {
    reopen();
    clickPill("Vercel");
    fold();
    probe.alpha!.pills.focus("alpha-pill");
    expect(front()).toBe("alpha-pill");
    tick(61_000);
    expect(front()).toBe("alpha-pill");
  });

  it("a pending request: the fold revert still happens and does not open the island", () => {
    reopen();
    clickPill("Vercel");
    fold();
    const off = probe.alpha!.island.request({ view: "home", priority: 10, pin: true });
    island.collapse(); tick(10);
    tick(61_000);
    expect(front()).toBe("claude-pill");
    expect(State.mode).not.toBe("expanded");
    off();
  });

  it("the default is explicit (done): it still takes the front, the island stays folded", () => {
    reopen();
    clickPill("Vercel");
    fold();
    probe.claude!.pills.set({ id: "claude-pill", mood: "done" });
    tick(61_000);
    expect(front()).toBe("claude-pill");
    expect(State.mode).not.toBe("expanded");
  });

  it("the timer never ran (time only jumped): a hover wake past the focus time puts the default in front", () => {
    reopen();
    clickPill("Vercel");
    fold();
    island.fsm.forceHidden(); tick(10);
    vi.setSystemTime(Date.now() + 61_000); // no timer ticks
    expect(front()).toBe("vercel-pill");
    island.fsm.forcePetit(); tick(10);
    expect(front()).toBe("claude-pill");
    expect(State.mode).not.toBe("expanded");
  });

  it("a wake before the focus time keeps the pick; a later wake past it reverts", () => {
    reopen();
    clickPill("Vercel");
    fold();
    island.fsm.forceHidden(); tick(10);
    island.fsm.forcePetit(); tick(10);
    expect(front()).toBe("vercel-pill");
    island.fsm.forceHidden(); tick(10);
    vi.setSystemTime(Date.now() + 61_000);
    island.fsm.forcePetit(); tick(10);
    expect(front()).toBe("claude-pill");
  });

  it("the front got news of its own: the revert leaves it and ends the pick", () => {
    reopen();
    clickPill("Vercel");
    fold();
    probe.vercel!.pills.set({ id: "vercel-pill", mood: "error" });
    tick(61_000);
    expect(front()).toBe("vercel-pill");
    probe.vercel!.pills.set({ id: "vercel-pill", mood: "idle" });
  });
});
