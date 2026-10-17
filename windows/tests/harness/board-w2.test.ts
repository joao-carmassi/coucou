// W2 board: actions.all/run in the core, the flip (owner's actions), the Utilidades view and the "Último" chip.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";

const probe: Record<string, IslandApi | null> = {};
const ran: string[] = [];

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const mod = (id: string, withActions: boolean): ModuleDef => ({
    id,
    start(api) {
      probe[id] = api;
      api.pills.set({ id: `${id}-pill`, label: id, color: "#88aaff", mood: "idle" });
      const offs = withActions ? [
        api.actions.add({ id: "zeta", title: "Zeta", key: "z", run: () => { ran.push(`${id}.zeta`); } }),
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

describe("actions.all / run", () => {
  it("lists owners without run closures, runs, routes throws to error", () => {
    const all = probe.beta!.actions.all();
    const z = all.find((a) => a.key === "alpha.zeta")!;
    expect(z).toEqual({ key: "alpha.zeta", title: "Zeta", owner: "alpha", keyHint: "z" });
    expect(all.some((a) => a.owner === "board")).toBe(true);
    expect(Object.keys(z)).not.toContain("run");
    expect(probe.beta!.actions.run("alpha.zeta")).toBe(true);
    expect(ran).toEqual(["alpha.zeta"]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(probe.beta!.actions.run("alpha.boom")).toBe(true);
    expect(probe.beta!.actions.run("nope.x")).toBe(false);
    err.mockRestore();
  });
});

describe("board flip, utilities, chip", () => {
  it("flip shows the owner's actions; no actions = no flip button", () => {
    probe.alpha!.pills.focus("alpha-pill");
    show("overview");
    expect(q(".flip")!.style.display).toBe("");
    q(".flip")!.click();
    tick(50);
    const btns = [...document.querySelectorAll(".tile-card.back .btn")].map((b) => b.textContent);
    expect(btns).toEqual(expect.arrayContaining(["Zeta", "Boom"]));
    expect(btns).not.toContain("Abrir Utilidades");
    probe.beta!.pills.focus("beta-pill");
    show("overview");
    tick(50);
    expect(q(".flip")!.style.display).toBe("none");
    expect(q(".tile-card.back")).toBeNull();
  });

  it("utilities lists all sorted, click runs and sets the chip; the chip clears when the action goes", () => {
    show("utilities");
    const titles = [...document.querySelectorAll(".board-util span")].map((e) => e.textContent);
    expect(titles).toEqual([...titles].sort((a, b) => a!.localeCompare(b!, "pt")));
    expect(titles).toContain("Abrir Utilidades");
    const zeta = [...document.querySelectorAll<HTMLElement>(".board-util")].find((b) => b.textContent!.startsWith("Zeta"))!;
    expect(zeta.textContent).toContain("Alt+Z");
    zeta.click();
    expect(ran).toEqual(["alpha.zeta", "alpha.zeta"]);
    show("overview");
    expect(q(".board-last")!.textContent).toBe("Último: Zeta");
    Registry.apply({ board: true, alpha: false, beta: true });
    show("overview");
    expect(q(".board-last")!.style.display).toBe("none");
    expect(probe.beta!.actions.all().some((a) => a.owner === "alpha")).toBe(false);
  });
});
