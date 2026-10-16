// Sistema: nothing runs when off; the view samples only while open; alerts probe only when enabled; stop cleans up.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { sysmonModule } from "../../src/modules/sysmon";
import manifest from "../../src/modules/sysmon/manifest.json";

const n = (cmd: string) => calls.invoke.filter((c) => c.cmd === cmd).length;
let island: Island;

beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [sysmonModule], buildCatalog([manifest as never], true));
  island.launch();
});
afterAll(() => vi.useRealTimers());

describe("sysmon module", () => {
  it("disabled: no view, no command, no timer", () => {
    Registry.apply({ sysmon: false });
    vi.advanceTimersByTime(60_000);
    expect(calls.invoke.filter((c) => c.cmd.startsWith("sysmon_"))).toEqual([]);
  });

  it("enabled with alerts off: no probe in the background", () => {
    Registry.apply({ sysmon: true });
    vi.advanceTimersByTime(120_000);
    expect(n("sysmon_alert_probe")).toBe(0);
    expect(n("sysmon_sample")).toBe(0);
  });

  it("alerts on: one probe every 15 s; stop ends them", () => {
    Registry.apply({ sysmon: false });
    (State.settings as unknown as Record<string, unknown>).sysmonAlerts = true;
    Registry.apply({ sysmon: true });
    vi.advanceTimersByTime(46_000);
    expect(n("sysmon_alert_probe")).toBe(3);
    Registry.apply({ sysmon: false });
    const after = n("sysmon_alert_probe");
    vi.advanceTimersByTime(60_000);
    expect(n("sysmon_alert_probe")).toBe(after);
  });
});
