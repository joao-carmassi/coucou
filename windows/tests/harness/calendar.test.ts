// Calendário through the real island: off = nothing; on + visible = one fetch and one reminder notice; hidden = no network; stop cleans up.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";

const fmt = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    if (cmd === "calendar_list") return [{ slot: 1, host: "calendar.test" }];
    if (cmd === "calendar_fetch") {
      const at = Date.now() + 5 * 60_000;
      return { notModified: false, body: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:${fmt(at)}\r\nDTEND:${fmt(at + 3600_000)}\r\nSUMMARY:Reunião\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` };
    }
    return null;
  },
}));

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

const loadModules = async () => ({ MODULES: [(await import("../../src/modules/calendar")).calendarModule] });
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return { MODULE_INFO: buildCatalog([{ id: "calendar", label: "Calendário", default: false, order: 16, settingsDefaults: { calendarRemindMin: 10, calendarDaysAhead: 7 } }], true) };
};

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const cal = (cmd?: string) => calls.invoke.filter((c) => c.cmd.startsWith("calendar_") && (!cmd || c.cmd === cmd));

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ calendar: false });
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("calendar module", () => {
  it("off: no command, no tab, no timer", async () => {
    await tick(60 * 60_000);
    expect(cal()).toHaveLength(0);
    expect(State.tabs.some((t) => t.view === "calendar")).toBe(false);
  });

  it("on and visible: one list + fetch, then the reminder notice for the next event", async () => {
    island.reveal();
    await tick(500);
    Registry.apply({ calendar: true });
    await tick(200);
    expect(cal("calendar_list")).toHaveLength(1);
    expect(cal("calendar_fetch")).toHaveLength(1);
    expect(cal("calendar_fetch")[0].args).toEqual({ slot: 1, have: false });
    expect(State.tabs.some((t) => t.view === "calendar")).toBe(true);
    expect(State.statusLine?.text).toMatch(/^Reunião começa em \d+ min$/);
  });

  it("waking the island refreshes conditionally (have: true), never within 15 minutes of the last one", async () => {
    island.hide();
    await tick(5 * 60_000);
    island.reveal();
    await tick(500);
    expect(cal("calendar_fetch")).toHaveLength(1);
    island.hide();
    await tick(11 * 60_000);
    island.reveal();
    await tick(500);
    expect(cal("calendar_fetch")).toHaveLength(2);
    expect(cal("calendar_fetch").at(-1)!.args).toEqual({ slot: 1, have: true });
  });

  it("hidden island: no network", async () => {
    island.hide();
    await tick(10);
    const before = cal().length;
    await tick(3 * 60 * 60_000);
    expect(cal()).toHaveLength(before);
  });

  it("stop: nothing left, nothing runs", async () => {
    Registry.apply({ calendar: false });
    await tick(10);
    const before = calls.invoke.length;
    await tick(3 * 60 * 60_000);
    expect(calls.invoke).toHaveLength(before);
    expect(State.tabs.some((t) => t.view === "calendar")).toBe(false);
  });
});
