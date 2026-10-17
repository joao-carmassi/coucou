// Sistema: nothing runs when off; the view samples only while open and releases on leave/hide; alerts probe only when
// enabled; a frozen temperature never re-fires after the view is gone; stop cleans up.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyModule, dummyProbe } from "./dummyModule";

const SNAP = { cpu: 1, ramUsed: 1, ramTotal: 2, disks: [], diskBusy: null, netDown: null, netUp: null, gpu: 36.4, gpuMem: null, driveTemps: [{ name: "Disco 0", celsius: 99 }] };
const bus = vi.hoisted(() => ({ fns: [] as ((p: unknown) => void)[] }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (p: unknown) => void) => {
    if (name === "settings-changed") bus.fns.push(fn);
    return () => { const i = bus.fns.indexOf(fn); if (i >= 0) bus.fns.splice(i, 1); };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    if (cmd === "sysmon_sample") return SNAP;
    if (cmd === "sysmon_quick") return { cpu: 52.6, ram: 38.2, gpu: 36.4 };
    if (cmd === "sysmon_alert_probe") return { cpu: 1, ram: 1, disk: null };
    if (cmd === "sysmon_lhm_info") return { version: "0", url: "https://x.test/a.zip", size: 1, sha256: "", installed: false, dir: "C:/x/LibreHardwareMonitor-0" };
    return null;
  },
}));

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { Compact } from "../../src/core/compact";
import { Pin } from "../../src/core/pin";
import { buildCatalog } from "../../src/modules/resolve";
import { sysmonModule } from "../../src/modules/sysmon";
import manifest from "../../src/modules/sysmon/manifest.json";

const n = (cmd: string) => calls.invoke.filter((c) => c.cmd === cmd).length;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
let island: Island;

beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [dummyModule, sysmonModule], buildCatalog([{ id: "dummy", label: "Dummy", default: true, order: 200 }, manifest as never], true));
  island.launch();
});
afterAll(() => vi.useRealTimers());

describe("sysmon module", () => {
  it("disabled: no view, no command, no timer", async () => {
    Registry.apply({ dummy: true, sysmon: false });
    await tick(60_000);
    expect(calls.invoke.filter((c) => c.cmd.startsWith("sysmon_"))).toEqual([]);
  });

  it("enabled with alerts off and view closed: nothing in the background", async () => {
    Registry.apply({ sysmon: true });
    await tick(120_000);
    expect(n("sysmon_alert_probe")).toBe(0);
    expect(n("sysmon_sample")).toBe(0);
  });

  it("view open -> sample; hidden island -> release and no more samples", async () => {
    dummyProbe.api!.island.open("sysmon");
    await tick(2_500);
    expect(n("sysmon_sample")).toBeGreaterThan(0);
    expect(calls.invoke.find((c) => c.cmd === "sysmon_sample")!.args).toEqual({ opts: { temps: true } });
    const releases = n("sysmon_release");
    dummyProbe.api!.island.hide();
    await tick(10);
    expect(n("sysmon_release")).toBeGreaterThan(releases);
    const s = n("sysmon_sample");
    await tick(30_000);
    expect(n("sysmon_sample")).toBe(s);
  });

  it("alerts on: probe every 15 s; a temperature seen once does not re-fire after the view is gone", async () => {
    Registry.apply({ sysmon: false });
    (State.settings as unknown as Record<string, unknown>).sysmonAlerts = true;
    const notices: string[] = [];
    const spy = vi.spyOn(island, "addNotice").mockImplementation((_o, nn) => (notices.push(nn.text), () => {}));
    Registry.apply({ sysmon: true });
    dummyProbe.api!.island.open("sysmon");
    await tick(2_500); // temp 99 read from the drive
    const p0 = n("sysmon_alert_probe");
    for (let i = 0; i < 31; i++) { dummyProbe.api!.island.open("sysmon"); await tick(1_000); } // keep the view open
    expect(n("sysmon_alert_probe") - p0).toBe(2);
    expect(notices.filter((t) => t.startsWith("Temperatura"))).toHaveLength(1);
    dummyProbe.api!.island.hide();
    await tick(10);
    await tick(15_000 * 50); // past the 10 min cooldown
    expect(notices.filter((t) => t.startsWith("Temperatura"))).toHaveLength(1);
    spy.mockRestore();
    Registry.apply({ sysmon: false });
    const after = n("sysmon_alert_probe");
    await tick(60_000);
    expect(n("sysmon_alert_probe")).toBe(after);
  });

  it("toggling sysmonAlerts in the settings window arms and disarms the probe", async () => {
    const s = State.settings as unknown as Record<string, unknown>;
    s.sysmonAlerts = false;
    Registry.apply({ sysmon: true });
    await tick(20);
    const p0 = n("sysmon_alert_probe");
    await tick(60_000);
    expect(n("sysmon_alert_probe")).toBe(p0);
    s.sysmonAlerts = true;
    bus.fns.forEach((f) => f({}));
    await tick(31_000);
    expect(n("sysmon_alert_probe") - p0).toBe(2);
    s.sysmonAlerts = false;
    bus.fns.forEach((f) => f({}));
    await tick(10);
    const p1 = n("sysmon_alert_probe");
    await tick(60_000);
    expect(n("sysmon_alert_probe")).toBe(p1);
    Registry.apply({ sysmon: false });
  });

  it("unpinned: the open view keeps the usage line fresh, it stays after leaving, and nothing polls", async () => {
    const line = () => Pin.list().find((s) => s.id === "sysmon.usage")?.line?.text ?? null;
    State.settings.pinnedLine = "";
    Registry.apply({ sysmon: false });
    Registry.apply({ sysmon: true });
    await tick(20);
    expect(line()).toBeNull();
    const q = n("sysmon_quick");
    dummyProbe.api!.island.open("sysmon");
    await tick(2_500);
    expect(line()).toBe("CPU 1% · RAM 50% · GPU 36%");
    expect(n("sysmon_quick")).toBe(q); // the view's own samples, not the quick poll
    dummyProbe.api!.island.open("dummy");
    await tick(2_500);
    dummyProbe.api!.island.hide();
    await tick(60_000);
    expect(line()).toBe("CPU 1% · RAM 50% · GPU 36%"); // frozen, there for the core's focus time
    expect(n("sysmon_quick")).toBe(q);
    Registry.apply({ sysmon: false });
    expect(Pin.list().find((s) => s.id === "sysmon.usage")).toBeUndefined();
  });

  it("pinned usage line: one 4 s interval, only while visible; text; unpinned/hidden/disabled arm none", async () => {
    const live = new Set<unknown>();
    const armed: number[] = [];
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = ((fn: () => void, ms: number) => { const id = si(fn, ms); live.add(id); armed.push(ms); return id; }) as typeof window.setInterval;
    window.clearInterval = ((id: number) => { live.delete(id); ci(id); }) as typeof window.clearInterval;
    try {
      State.settings.pinnedLine = "";
      Registry.apply({ sysmon: false });
      Registry.apply({ sysmon: true });
      await tick(20_000);
      expect(live.size).toBe(0);
      expect(n("sysmon_quick")).toBe(0);
      Registry.apply({ sysmon: false });
      State.settings.pinnedLine = "sysmon.usage";
      State.settings.compactHideInterval = 0;
      island.reveal();
      await tick(20);
      expect(live.size).toBe(0); // pinned but the module is disabled
      Registry.apply({ sysmon: true });
      await tick(20);
      expect(live.size).toBe(1);
      expect(armed.at(-1)).toBe(4000);
      expect(n("sysmon_quick")).toBe(1);
      expect(calls.invoke.filter((c) => c.cmd === "sysmon_quick")[0].args).toEqual({ fresh: true });
      expect(Compact.resolve(0)?.text).toBe("CPU 53% · RAM 38% · GPU 36%");
      await tick(8_100);
      expect(n("sysmon_quick")).toBe(3);
      island.hide();
      await tick(20);
      expect(live.size).toBe(0);
      const q = n("sysmon_quick");
      await tick(60_000);
      expect(n("sysmon_quick")).toBe(q);
      island.reveal();
      await tick(20);
      expect(live.size).toBe(1);
      State.settings.pinnedLine = "";
      island.applySettings();
      await tick(20);
      Registry.apply({ sysmon: false });
      expect(live.size).toBe(0);
    } finally {
      State.settings.pinnedLine = "";
      State.settings.compactHideInterval = 60;
      window.setInterval = si;
      window.clearInterval = ci;
      Registry.apply({ sysmon: false });
    }
  });
});
