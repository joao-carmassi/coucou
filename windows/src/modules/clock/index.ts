// Proof module: lives only in this folder (manifest.json, this file, view, settings), no Rust.
// Tab "Relógio" with the time; the 1 s interval exists only while the island is visible AND this
// view is open (it arms on view.sync and disarms itself the first tick after the view is left).
import "./clock.css";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { ICONS } from "../../kit/icons";
import { formatOf, timeText } from "./format";
import { buildClockView } from "./view";

const readout = document.createElement("div");
readout.className = "clock-readout";
let arm: (() => void) | null = null;

function start(api: IslandApi): Disposer {
  let tick: Disposer | null = null;
  let hourWinked = -1;
  const open = () => api.island.view() === "clock" && api.island.mode() === "expanded";
  const stopTicking = () => { tick?.(); tick = null; api.status.set(null); };
  const update = () => {
    if (!open()) return stopTicking();
    const now = new Date();
    const fmt = formatOf(api.settings());
    readout.textContent = timeText(now, fmt);
    api.status.set({ priority: BAND.AMBIENT, text: timeText(now, fmt, false) });
    if (now.getMinutes() === 0 && hourWinked !== now.getHours()) {
      hourWinked = now.getHours();
      api.avatar.emote("wink");
    }
  };
  arm = () => { if (!tick && open()) tick = api.interval(update, 1000, { whenVisible: true }); update(); };
  return () => { arm = null; stopTicking(); };
}

export const clockModule: ModuleDef = {
  id: "clock",
  views: [{
    name: "clock",
    layout: { height: 160, botX: 54, botY: null, botDiameter: 46 },
    build: () => buildClockView(readout, () => arm?.()),
  }],
  tabs: [{ view: "clock", title: "Relógio", icon: () => svg(ICONS.dial, 13), order: 90 }],
  start,
};
