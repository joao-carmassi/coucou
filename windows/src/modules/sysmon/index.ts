// Sistema: CPU, memória, disco, rede, GPU and temperatures. The view samples only while open; the optional alert
// check runs every 15 s only when alerts are on (and Pause is off). The pinned "Uso do PC" line polls only while pinned.
import "./sysmon.css";
import { svg } from "../../kit/dom";
import { ICONS } from "../../kit/icons";
import { BAND, PANEL_H, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { SysmonBridge } from "./bridge";
import { AlertState, LABEL, USAGE_MS, clampInt, showOf, usageLine, type AlertKey } from "./logic";
import { buildSysmonView } from "./view";

interface Cfg { sysmonShow: unknown; sysmonAlerts: boolean; sysmonCpuMax: number; sysmonRamMax: number; sysmonDiskMax: number; sysmonTempMax: number }

let temp: number | null = null;

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
  const read = async (fresh = false) => {
    let line: string | null = null;
    try { line = usageLine(await SysmonBridge.quick(fresh), showOf(api.settings<Cfg>().sysmonShow)); } catch { /* null: the core releases the pin after 5 min */ }
    // Both metrics off in sysmonShow: a dim note keeps the pin instead of letting the core release it.
    const off = !!usagePoll && !line && !showOf(api.settings<Cfg>().sysmonShow).cpu && !showOf(api.settings<Cfg>().sysmonShow).ram;
    if (usagePoll) usage.set(line ? { priority: BAND.AMBIENT, icon: "📊", text: line } : off ? { priority: BAND.AMBIENT, icon: "📊", text: "Uso do PC: nada selecionado", dim: true } : null);
  };
  const reconcileUsage = () => {
    const on = api.status.pinned("usage");
    if (on && !usagePoll) { usagePoll = api.interval(() => void read(), USAGE_MS, { whenVisible: true }); void read(true); }
    else if (!on && usagePoll) { usagePoll(); usagePoll = null; usage.set(null); }
  };
  reconcileUsage();
  const offUsage = api.island.onChange(reconcileUsage);
  // The interval sleeps while hidden: on return read at once (fresh baseline) so no stale value shows.
  const offVis = api.onVisibility((mode) => { if (mode !== "hidden" && usagePoll) void read(true); });
  // Settings can flip alerts while running: look again whenever the island's state changes (cheap, no timer).
  const offChange = api.island.onChange(arm);
  // And on a settings change (deferred: the stored settings are replaced by a listener that runs after ours).
  const offSettings = api.listen("settings-changed", () => void api.timeout(arm, 0));
  return () => { offChange(); offUsage(); offVis(); usagePoll?.(); usagePoll = null; usage.dispose(); offSettings(); probe?.(); probe = null; temp = null; };
}

export const sysmonModule: ModuleDef = {
  id: "sysmon",
  views: [{
    name: "sysmon",
    layout: { height: PANEL_H, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildSysmonView(ctx, (c) => { temp = c; }),
  }],
  tabs: [{ view: "sysmon", title: "Sistema", icon: () => svg(ICONS.pulse, 13, { stroke: 1.6 }), order: 50 }],
  start,
};
