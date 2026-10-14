// Rust-less test module: 2 views, a pill, an overlay and a request that pins. Only the harness loads it.
import { BAND, type IslandApi, type ModuleDef, type ViewDef } from "../../src/core/moduleApi";

export const DUMMY_VIEWS = ["dummy-a", "dummy-b"] as const;
export const dummyProbe: { api: IslandApi | null; overlayFrames: number } = { api: null, overlayFrames: 0 };

const view = (name: string): ViewDef => ({
  name,
  layout: { height: 120, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  build: () => {
    const el = document.createElement("div");
    el.className = "view";
    el.textContent = name;
    return { el, sync() {} };
  },
});

export function requestPin(api: IslandApi, view: string, ms: number, priority = 10) {
  return api.island.request({ view, priority, pin: true, ms: ms || undefined });
}

export const dummyModule: ModuleDef = {
  id: "dummy",
  label: "Dummy",
  defaultEnabled: true,
  views: DUMMY_VIEWS.map(view),
  tabs: DUMMY_VIEWS.map((v, i) => ({ view: v, title: v, icon: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"), order: 10 + i })),
  start(api) {
    dummyProbe.api = api;
    api.pills.set({ id: "dummy-pill", label: "Dummy", color: "#88aaff", mood: "idle" });
    api.status.set({ priority: BAND.ACTIVE, text: "dummy status" });
    const el = document.createElement("div");
    el.className = "dummy-overlay";
    const off = api.island.overlay({ el, active: () => false, frame: () => (dummyProbe.overlayFrames++, false) });
    return () => { off(); dummyProbe.api = null; };
  },
} as ModuleDef;
