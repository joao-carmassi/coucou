// Vitrine: two dummy pills and a status line, for showcase screenshots. Only core/moduleApi; no view, no Rust.
// The pills are removed by the core when the module stops; the status line is cleared here.
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";

function start(api: IslandApi): Disposer {
  api.pills.set({ id: "demo-alfa", label: "Alfa", color: "#88aaff", mood: "idle" });
  api.pills.set({ id: "demo-beta", label: "Beta", color: "#ffaa88", mood: "idle" });
  api.status.set({ priority: BAND.ACTIVE, text: "Vitrine" });
  return () => api.status.set(null);
}

export const demoModule: ModuleDef = { id: "demo", start };
