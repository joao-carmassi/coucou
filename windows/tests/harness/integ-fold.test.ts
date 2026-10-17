// Folded island while an integration pill is front: news must reach the compact island without a click.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";

const handlers: Record<string, (p: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "integrations_secret_present" ? true : null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (p: { payload: unknown }) => void) => ((handlers[name] = fn), () => {}),
}));
const probe: { api: IslandApi | null } = { api: null };
const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const { vercel } = await import("../../src/modules/integrations");
  const prov: ModuleDef = {
    id: "claude",
    start(api) {
      probe.api = api;
      api.pills.set({ id: "claude-pill", label: "Claude", color: "#88aaff", mood: "idle" });
      const off = api.provide<(id: string) => void>("board.focus", (id) => { if (id === "claude-pill") api.pills.focus(id); });
      return () => { off(); probe.api = null; };
    },
  } as ModuleDef;
  return { MODULES: [board, prov, vercel] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  const manifest = (await import("../../src/modules/board/manifest.json")).default;
  return { MODULE_INFO: buildCatalog([manifest, { id: "claude", label: "Claude", default: true, order: 1 }, { id: "vercel", label: "Vercel", default: true, order: 3 }], true) };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const news = (success: boolean) => handlers["integration"]({ payload: { id: "integration_vercel", data: { x: 1 }, error: null, event: { success, label: "deploy", detail: "ok" } } });

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ board: true, claude: true, vercel: true });
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("folded island with an integration pill", () => {
  const eng = () => (island as unknown as { engine: { state: string } }).engine.state;
  const grid = () => (document.getElementById("mini-grid") as HTMLElement).dataset.key;
  const pick = () => {
    island.fsm.forceHome(); tick(100);
    [...document.querySelectorAll<HTMLElement>(".pill")].find((p) => p.textContent === "Vercel")!.click(); tick(100);
  };
  const fold = () => { island.collapse(); tick(500); };

  it("news on the picked (front) pill reaches the folded island without a click", () => {
    pick();
    expect(State.focusPill?.id).toBe("integration_vercel");
    fold();
    expect(State.mode).toBe("compact");
    news(false); tick(100);
    expect(eng()).toBe("error");
    expect(State.gridPills.map((p) => p.id)).not.toContain("integration_vercel"); // not forced into the grid
  });

  it("news on a pill that is not in front lands in the folded grid without a click", () => {
    probe.api!.pills.focus("claude-pill"); tick(100);
    probe.api!.status.set(null);
    expect(State.mode).toBe("compact");
    news(true); tick(100);
    expect(grid()).toContain("integration_vercel");
  });

  it("ambient (idle) integration: hidden while a status line shows, listed when nobody works", () => {
    tick(61_000); // settles to idle (ambient)
    probe.api!.pills.remove("claude-pill");
    probe.api!.pills.set({ id: "claude-pill", label: "Claude", color: "#88aaff", mood: "idle", ambient: true });
    probe.api!.pills.focus("claude-pill");
    probe.api!.status.set({ priority: 30, text: "trabalhando" });
    island.fsm.forcePetit(); tick(500);
    expect(State.statusLine?.text).toBe("trabalhando");
    expect(State.gridPills).toEqual([]);
    probe.api!.status.set(null); tick(100);
    expect(State.gridPills.map((p) => p.id)).toEqual(["integration_vercel"]);
  });

  it("picked integration, folded, Claude starts working: past the hold time the folded island shows Claude, no click", () => {
    Object.assign(State.settings, { boardPrimary: "claude", compactHideInterval: 60 });
    probe.api!.status.set(null);
    probe.api!.pills.set({ id: "claude-pill", ambient: false, mood: "idle" });
    pick();
    expect(State.focusPill?.id).toBe("integration_vercel");
    fold();
    probe.api!.pills.set({ id: "claude-pill", mood: "working" });
    probe.api!.status.set({ priority: 30, text: "trabalhando" });
    tick(61_000);
    island.fsm.forcePetit(); tick(500);
    expect(State.focusPill?.id).toBe("claude-pill");
    expect(State.statusLine?.text).toBe("trabalhando");
    expect(eng()).toBe("working");
    expect(State.mode).not.toBe("expanded");
  });

  it("picked integration, folded, Claude done: the hover wake past the hold time shows Claude even if the timer never ran", () => {
    Object.assign(State.settings, { boardPrimary: "claude", compactHideInterval: 60 });
    probe.api!.status.set(null);
    probe.api!.pills.set({ id: "claude-pill", ambient: false, mood: "idle" });
    pick();
    expect(State.focusPill?.id).toBe("integration_vercel");
    fold();
    probe.api!.pills.set({ id: "claude-pill", mood: "done" });
    island.fsm.forceHidden(); tick(500);
    vi.setSystemTime(Date.now() + 61_000);
    island.fsm.forcePetit(); tick(500);
    expect(State.focusPill?.id).toBe("claude-pill");
    expect(State.mode).not.toBe("expanded");
  });
});
