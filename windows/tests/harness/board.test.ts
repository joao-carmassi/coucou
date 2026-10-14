// The board owns Início: it draws the pill list and asks the OWNER of each pill for its card, so
// pills of any module have a surface without Claude. Providers here are Rust-less dummies.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModuleDef } from "../../src/core/moduleApi";
import type { BoardCardOf, BoardNewsOf } from "../../src/modules/board/api";

const probe: Record<string, import("../../src/core/moduleApi").IslandApi | null> = {};

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const provider = (id: string, label: string, news = false): ModuleDef => ({
    id,
    start(api) {
      probe[id] = api;
      api.pills.set({ id: `${id}-pill`, label, color: "#88aaff", mood: "idle" });
      const offs = [
        api.provide<BoardCardOf>("board.card", (tid) => tid !== `${id}-pill` ? null : {
          key: `${id}`,
          build: () => Object.assign(document.createElement("div"), { className: "tile-card", textContent: `card of ${label}` }),
          target: true,
        }),
        news ? api.provide<BoardNewsOf>("board.news", (tid) => tid === `${id}-pill` ? { says: "x", title: "y", facts: [] } : null) : () => {},
      ];
      return () => { offs.forEach((o) => o()); probe[id] = null; };
    },
  } as ModuleDef);
  return { MODULES: [board, provider("alpha", "Alpha"), provider("beta", "Beta", true)] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "board", label: "Painel", default: true, order: 0 },
      { id: "alpha", label: "Alpha", default: true, order: 1 },
      { id: "beta", label: "Beta", default: true, order: 2 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const text = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.textContent);
const home = () => { probe.alpha?.island.setView("overview"); tick(100); };

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ board: true, alpha: false, beta: false });
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("board", () => {
  it("alone: Início is home and says so when no pill exists", () => {
    expect(State.tabs.map((t) => t.view)).toEqual(["overview"]);
    expect(State.tabs[0].home).toBe(true);
    expect(State.defaultView()).toBe("overview");
    island.open("overview");
    tick(100);
    expect(State.view).toBe("overview");
    expect(text(".tile-head b")).toContain("Nada por aqui");
  });

  it("a module's pill gets its card from its owner through board.card", () => {
    Registry.apply({ board: true, alpha: true, beta: false });
    island.open("overview");
    tick(100);
    expect(text(".tile-card")).toContain("card of Alpha");
    expect(document.querySelector(".overview.solo")).not.toBeNull();
  });

  it("another provider joining does not change the front card; its pill is listed", () => {
    Registry.apply({ board: true, alpha: true, beta: true });
    tick(100);
    expect(text(".tile-card")).toContain("card of Alpha");
    expect(text(".pill .lbl")).toEqual(["Beta"]);
    expect(document.querySelector(".overview.solo")).toBeNull();
  });

  it("a provider leaving keeps the others' cards", () => {
    probe.beta!.pills.focus("beta-pill");
    tick(100);
    expect(text(".tile-card")).toContain("card of Beta");
    Registry.apply({ board: true, alpha: false, beta: true });
    tick(100);
    expect(text(".tile-card")).toContain("card of Beta");
    expect(State.pills.map((p) => p.id)).toEqual(["beta-pill"]);
  });

  it("no modules at all: the empty view, no tabs", () => {
    Registry.apply({ board: false, alpha: false, beta: false });
    tick(100);
    expect(State.tabs).toHaveLength(0);
    expect(State.view).toBe("empty");
  });
});
