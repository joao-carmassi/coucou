// WP-C: board/media/upload reach the core only through the module api.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";

const probe: { api: IslandApi | null } = { api: null };

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const p: ModuleDef = {
    id: "alpha", label: "Alpha", defaultEnabled: true,
    start(api) {
      probe.api = api;
      api.pills.set({ id: "a1", label: "A1", color: "#88aaff", mood: "idle" });
      api.pills.set({ id: "a2", label: "A2", color: "#ffaa88", mood: "idle" });
      return () => { probe.api = null; };
    },
  };
  return { MODULES: [board, p] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return { MODULE_INFO: buildCatalog([
    { id: "board", label: "Painel", default: true, order: 0 },
    { id: "alpha", label: "Alpha", default: true, order: 1 },
  ], true) };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { miniBotCount } from "../../src/mochi/minibots";

const tick = (ms: number) => vi.advanceTimersByTime(ms);
beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ board: true, alpha: true });
  island.launch();
  tick(15_000);
  island.open("overview");
  tick(100);
});
afterAll(() => vi.useRealTimers());

describe("wpc", () => {
  it("board lists the other pill with a live mini via api.mochi.mini", () => {
    expect(document.querySelectorAll(".pill canvas").length).toBe(1);
    expect(miniBotCount()).toBeGreaterThan(0);
    probe.api!.pills.set({ id: "a3", label: "A3", color: "#fff", mood: "idle" });
    tick(100);
    expect(document.querySelectorAll(".pill canvas").length).toBe(2);
    tick(1000); // minis keep ticking without throwing
  });

  it("media ghost sprite draws through api.mochi.sprite", () => {
    const s = probe.api!.mochi.sprite({ overhang: 40 });
    const ctx = document.createElement("canvas").getContext("2d")!;
    s.color("#123456"); s.setState("idle", true); s.emote("surprised", 60);
    expect(() => { s.update(0.016); s.draw(ctx, 84, 124); }).not.toThrow();
  });

  it("upload reads home and the local cursor from the api", () => {
    const { island } = probe.api!;
    expect(island.home()).toBe("overview");
    expect(island.mouseLocal()).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });
});
