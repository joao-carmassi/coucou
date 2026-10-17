// W2 board: actions.all in the core and the "Último" chip.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";

const probe: Record<string, IslandApi | null> = {};

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const mod = (id: string, withActions: boolean): ModuleDef => ({
    id,
    start(api) {
      probe[id] = api;
      api.pills.set({ id: `${id}-pill`, label: id, color: "#88aaff", mood: "idle" });
      const offs = withActions ? [
        api.actions.add({ id: "zeta", title: "Zeta", key: "z", run: () => {} }),
        api.actions.add({ id: "boom", title: "Boom", run: () => { throw new Error("boom"); } }),
      ] : [];
      return () => { offs.forEach((o) => o()); probe[id] = null; };
    },
  } as ModuleDef);
  return { MODULES: [board, mod("alpha", true), mod("beta", false)] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return { MODULE_INFO: buildCatalog([
    { id: "board", label: "Painel", default: true, order: 0 },
    { id: "alpha", label: "Alpha", default: true, order: 1 },
    { id: "beta", label: "Beta", default: true, order: 2 },
  ], true) };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const show = (v: string) => { island.open(v); tick(100); };

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ board: true, alpha: true, beta: true });
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("actions.all", () => {
  it("lists owners without run closures", () => {
    const all = probe.beta!.actions.all();
    const z = all.find((a) => a.key === "alpha.zeta")!;
    expect(z).toEqual({ key: "alpha.zeta", title: "Zeta", owner: "alpha", keyHint: "z" });
    expect(Object.keys(z)).not.toContain("run");
  });
});

describe("board chip", () => {
  it("the chip shows the last action run, and clears when that action goes", async () => {
    const { last } = await import("../../src/modules/board/last");
    last.key = "alpha.zeta";
    show("overview");
    expect(q(".board-last")!.textContent).toBe("Último: Zeta");
    Registry.apply({ board: true, alpha: false, beta: true });
    show("overview");
    expect(q(".board-last")!.style.display).toBe("none");
    expect(probe.beta!.actions.all().some((a) => a.owner === "alpha")).toBe(false);
  });

  it("the card has no arrow, flip or utilities buttons", () => {
    show("overview");
    expect(q(".jump")).toBeNull();
  });
});
