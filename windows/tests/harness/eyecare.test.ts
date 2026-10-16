// Pausas: nothing runs while off; on = one reminder timeout, no polling; a stop clears it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { eyecareModule } from "../../src/modules/eyecare";
import manifest from "../../src/modules/eyecare/manifest.json";

const os = vi.hoisted(() => ({ idle: 1000 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    return cmd === "eyecare_checkpoint" ? os.idle : null;
  },
}));

const handlers = vi.hoisted(() => ({ list: [] as (() => void)[] }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: () => void) => {
    if (name === "settings-changed") handlers.list.push(fn);
    return () => { handlers.list = handlers.list.filter((h) => h !== fn); };
  },
}));
const changed = async () => { handlers.list.slice().forEach((f) => (f as (e: unknown) => void)({ payload: {} })); await tick(1); };
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const eye = () => calls.invoke.filter((c) => c.cmd.startsWith("eyecare_")).length;
const notice = () => document.body.textContent ?? "";

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [eyecareModule], buildCatalog([manifest as never], true));
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("eyecare module", () => {
  it("does nothing while disabled", async () => {
    Registry.apply({ eyecare: false });
    await tick(3 * 3600_000);
    expect(eye()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms one timeout, fires a checkpoint and a notice, rearms", async () => {
    State.settings.eyecareInterval = 20;
    Registry.apply({ eyecare: true });
    await tick(19 * 60_000);
    expect(eye()).toBe(0);
    await tick(61_000);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint")).toHaveLength(1);
    expect(notice()).toContain("Descanse os olhos");
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
  });

  it("an idle user (5 min+) is not nagged, and stop leaves nothing armed", async () => {
    os.idle = 6 * 60_000;
    State.settings.eyecareKinds = ["water"];
    const n = calls.invoke.length;
    await tick(20 * 60_000 + 100);
    expect(calls.invoke.slice(n).filter((c) => c.cmd === "eyecare_checkpoint")).toHaveLength(1);
    expect(notice()).not.toContain("Beba");
    Registry.apply({ eyecare: false });
    const after = eye();
    await tick(3 * 3600_000);
    expect(eye()).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interval 0 arms nothing", async () => {
    State.settings.eyecareInterval = 0;
    Registry.apply({ eyecare: true });
    const t = vi.getTimerCount();
    const e = eye();
    await tick(3 * 3600_000);
    expect(eye()).toBe(e);
    expect(vi.getTimerCount()).toBe(t);
    Registry.apply({ eyecare: false });
  });

  it("0 -> 20 arms a timer; 20 -> 0 stops the next reminder", async () => {
    State.settings.eyecareInterval = 0;
    State.settings.eyecareKinds = ["eyes"];
    os.idle = 1000;
    Registry.apply({ eyecare: true });
    await tick(5);
    State.settings.eyecareInterval = 20;
    await changed();
    const n = calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length;
    await tick(20 * 60_000 + 100);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length).toBe(n + 1);
    State.settings.eyecareInterval = 0;
    await changed();
    await tick(3 * 3600_000);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length).toBe(n + 1);
    expect(vi.getTimerCount()).toBe(0);
    Registry.apply({ eyecare: false });
  });
});
