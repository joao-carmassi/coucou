// Sistema: nothing runs when off; the view samples only while open and releases on leave/hide; alerts probe only when
// enabled; a frozen temperature never re-fires after the view is gone; stop cleans up.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyModule, dummyProbe } from "./dummyModule";

const SNAP = { cpu: 1, ramUsed: 1, ramTotal: 2, disks: [], diskBusy: null, netDown: null, netUp: null, gpu: null, gpuMem: null, driveTemps: [{ name: "Disco 0", celsius: 99 }], byCpu: [], byMem: [] };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    if (cmd === "sysmon_sample") return SNAP;
    if (cmd === "sysmon_alert_probe") return { cpu: 1, ram: 1, disk: null };
    if (cmd === "sysmon_lhm_info") return { version: "0", url: "https://x.test/a.zip", size: 1, sha256: "", installed: false, dir: "C:/x/LibreHardwareMonitor-0" };
    return null;
  },
}));

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
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
});
