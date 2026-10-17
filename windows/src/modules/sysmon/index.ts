// Sistema: CPU, memória, disco, rede, GPU and temperatures. The view samples only while open; the optional alert
// check runs every 15 s only when alerts are on (and Pause is off). The "Uso do PC" line is kept fresh by the open view's samples
// (so it is there for the focus time after leaving) and polls on its own only while pinned.
import "./sysmon.css";
import { svg } from "../../kit/dom";
import { ICONS } from "../../kit/icons";
import { BAND, PANEL_H, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { SysmonBridge, type Snapshot } from "./bridge";
import { AlertState, LABEL, USAGE_MS, clampInt, showOf, usageLine, type AlertKey } from "./logic";
import { buildSysmonView } from "./view";

interface Cfg { sysmonShow: unknown; sysmonAlerts: boolean; sysmonCpuMax: number; sysmonRamMax: number; sysmonDiskMax: number; sysmonTempMax: number }

let temp: number | null = null;
let onSnap: (s: Snapshot) => void = () => {};

function start(api: IslandApi): Disposer {
  const state = new AlertState();
  let probe: Disposer | null = null;
  let tick = 0;
  const check = async () => {
    const c = api.settings<Cfg>();
    if (!c.sysmonAlerts || api.paused()) return;
    let p;
    try { p = await SysmonBridge.alertProbe(tick++); } catch { return; }
    if (!p) return;
    const lim = { cpu: clampInt(c.sysmonCpuMax, 10, 100, 90), ram: clampInt(c.sysmonRamMax, 10, 100, 90), disk: clampInt(c.sysmonDiskMax, 10, 100, 95), temp: clampInt(c.sysmonTempMax, 40, 120, 85) };
    const read: Partial<Record<AlertKey, number | null>> = { cpu: p.cpu };
    if (p.ram != null) read.ram = p.ram;
    if (p.disk != null) read.disk = p.disk;
    if (temp != null) read.temp = temp;
    for (const k of state.step(read, lim)) {
      const v = read[k] as number;
      api.island.notice({ text: `${LABEL[k]} alta: ${Math.round(v)}${k === "temp" ? " °C" : "%"}`, priority: BAND.NOTICE, view: "sysmon", key: `alert-${k}`, peek: true });
    }
  };
  const arm = () => {
    const on = api.settings<Cfg>().sysmonAlerts === true;
    if (on && !probe) probe = api.interval(() => void check(), 15_000);
    else if (!on && probe) { probe(); probe = null; }
  };
  arm();
  // Pinned one-line source "usage": a light read (sysmon_quick) every USAGE_MS, armed only while pinned and the island is visible.
  const usage = api.status.source("usage", { label: "Uso do PC", view: "sysmon" });
  let usagePoll: Disposer | null = null;
  let lastLine: string | null = null; // the last known line stays (frozen) after the view is left or the pin is released
  const put = (line: string | null) => { if (line) lastLine = line; usage.set(line ? { priority: BAND.AMBIENT, icon: "📊", text: line } : null); };
  onSnap = (s) => {
    const p = { cpu: s.cpu, ram: s.ramTotal ? (s.ramUsed * 100) / s.ramTotal : null, gpu: s.gpu };
    const line = usageLine(p, showOf(api.settings<Cfg>().sysmonShow));
    if (line) put(line);
  };
  const read = async (fresh = false) => {
    let line: string | null = null;
    const show = showOf(api.settings<Cfg>().sysmonShow);
    try { line = usageLine(await SysmonBridge.quick(fresh), show); } catch { /* null: the core releases the pin after 5 min */ }
    if (!usagePoll) return;
    // Nothing selected in sysmonShow: a dim note keeps the pin instead of letting the core release it.
    if (!line && !show.cpu && !show.ram && !show.gpu) usage.set({ priority: BAND.AMBIENT, icon: "📊", text: "Uso do PC: nada selecionado", dim: true });
    else put(line);
  };
  const stopPoll = () => { usagePoll?.(); usagePoll = null; void SysmonBridge.quickStop().catch(() => {}); };
  const reconcileUsage = () => {
    const on = api.status.pinned("usage");
    if (on && !usagePoll) { usagePoll = api.interval(() => void read(), USAGE_MS, { whenVisible: true }); if (api.island.mode() !== "hidden") void read(true); }
    else if (!on && usagePoll) { stopPoll(); usage.set(lastLine ? { priority: BAND.AMBIENT, icon: "📊", text: lastLine } : null); }
  };
  reconcileUsage();
  const offUsage = api.island.onChange(reconcileUsage);
  // The interval sleeps while hidden: on return read at once (fresh baseline) so no stale value shows.
  const offVis = api.onVisibility((mode) => { if (!usagePoll) return; if (mode === "hidden") void SysmonBridge.quickStop().catch(() => {}); else void read(true); });
  // Settings can flip alerts while running: look again whenever the island's state changes (cheap, no timer).
  const offChange = api.island.onChange(arm);
  // And on a settings change (deferred: the stored settings are replaced by a listener that runs after ours).
  const offSettings = api.listen("settings-changed", () => void api.timeout(arm, 0));
  return () => { offChange(); offUsage(); offVis(); if (usagePoll) stopPoll(); onSnap = () => {}; usage.dispose(); offSettings(); probe?.(); probe = null; temp = null; };
}

export const sysmonModule: ModuleDef = {
  id: "sysmon",
  views: [{
    name: "sysmon",
    layout: { height: PANEL_H, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildSysmonView(ctx, (c) => { temp = c; }, (s) => onSnap(s)),
  }],
  tabs: [{ view: "sysmon", title: "Sistema", icon: () => svg(ICONS.pulse, 13, { stroke: 1.6 }), order: 50 }],
  start,
};
