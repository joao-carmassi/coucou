// Uso do plano: off = nothing; on = one local read, no Claude call without the opt-in; the opt-in alone never polls.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { planusageModule } from "../../src/modules/planusage";
import manifest from "../../src/modules/planusage/manifest.json";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    if (cmd === "planusage_get") return [{ agent: "codex", source: "local", at: 1, windows: [{ label: "5 h", usedPct: 17, resetsAt: null }] }];
    if (cmd === "planusage_claude") return { agent: "claude", source: "network", at: 1, windows: [{ label: "5 h", usedPct: 23, resetsAt: null }] };
    return null;
  },
}));

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const n = (cmd: string) => calls.invoke.filter((c) => c.cmd === cmd).length;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [planusageModule], buildCatalog([manifest as never], true));
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("planusage module", () => {
  it("does nothing while disabled", async () => {
    Registry.apply({ planusage: false });
    await tick(3600_000);
    expect(n("planusage_get") + n("planusage_claude")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("on with the network opt-in off: one local read, never a Claude call, no polling", async () => {
    State.settings.planusageClaudeNet = false;
    Registry.apply({ planusage: true });
    await tick(2000);
    expect(n("planusage_get")).toBe(1);
    const timers = vi.getTimerCount();
    await tick(3 * 3600_000);
    expect(n("planusage_claude")).toBe(0);
    expect(n("planusage_get")).toBe(1);
    expect(vi.getTimerCount()).toBe(timers);
  });

  it("opt-in on but the view closed: still no Claude call and no interval", async () => {
    State.settings.planusageClaudeNet = true;
    const timers = vi.getTimerCount();
    await tick(3 * 3600_000);
    expect(n("planusage_claude")).toBe(0);
    expect(vi.getTimerCount()).toBe(timers);
  });

  it("stop leaves nothing armed", async () => {
    Registry.apply({ planusage: false });
    const g = n("planusage_get");
    await tick(3 * 3600_000);
    expect(n("planusage_get")).toBe(g);
    expect(vi.getTimerCount()).toBe(0);
  });
});
