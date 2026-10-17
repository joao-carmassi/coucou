// Estatísticas de IA: a view with token counters from the Claude Code and Codex logs. No timer, no watcher:
// the logs are read (incrementally, in Rust) only when the view opens or "Atualizar" is clicked.
import "./aistats.css";
import { svg } from "../../kit/dom";
import { PANEL_H, type Disposer, type ModuleDef } from "../../core/moduleApi";
import { buildView } from "./view";

const BARS = "M5 20V10M12 20V4M19 20v-7";

export const aistatsModule: ModuleDef = {
  id: "aistats",
  views: [{ name: "aistats", layout: { height: PANEL_H, botX: 54, botY: null, botDiameter: 46 }, build: (ctx) => buildView(ctx) }],
  tabs: [{ view: "aistats", title: "Estatísticas de IA", icon: () => svg(BARS, 13, { stroke: 2 }), order: 110 }],
  start: (): Disposer => () => {},
};
