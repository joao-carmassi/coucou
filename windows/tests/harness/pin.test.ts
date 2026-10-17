// Pinned line and last-opened line (api.status.source): order against other lines, one pin, auto-release, click, module off.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyModule, dummyProbe } from "./dummyModule";
import { BAND, type IslandApi, type ModuleDef, type StatusSource } from "../../src/core/moduleApi";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { PIN_RELEASE_MS } from "../../src/core/sources";
import { moduleSettings } from "../../src/core/moduleSettings";
import { buildCatalog } from "../../src/modules/resolve";

const P: { a: IslandApi | null; b: IslandApi | null; sa: StatusSource | null; sb: StatusSource | null } = { a: null, b: null, sa: null, sb: null };
const mod = (id: "sa" | "sb"): ModuleDef => ({
  id: id === "sa" ? "srca" : "srcb",
  views: [{ name: `${id}-view`, layout: { height: 120, botX: 54, botY: null, botDiameter: 46 }, build: () => ({ el: document.createElement("div"), sync() {} }) }],
  tabs: [{ view: `${id}-view`, title: id, icon: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"), order: id === "sa" ? 50 : 51 }],
  start(api) {
    const s = api.status.source("line", { label: `Linha ${id}`, view: `${id}-view` });
    if (id === "sa") { P.a = api; P.sa = s; } else { P.b = api; P.sb = s; }
    return () => { if (id === "sa") P.a = P.sa = null; else P.b = P.sb = null; };
  },
});
const info = [
  { id: "dummy", label: "Dummy", default: true, order: 200 },
  { id: "srca", label: "A", default: true, order: 201 },
  { id: "srcb", label: "B", default: true, order: 202 },
];
const ON = { dummy: true, srca: true, srcb: true };

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const line = () => State.statusLine;
const fold = () => { island.collapse(); tick(10); };
const saves = () => calls.invoke.filter((c) => c.cmd === "save_settings").map((c) => (c.args as { patch: Record<string, unknown> }).patch);

beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [dummyModule, mod("sa"), mod("sb")], buildCatalog(info, true));
  Registry.apply(ON);
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  Registry.apply({ dummy: true, srca: false, srcb: false });
  State.settings.pinnedLine = "";
  Registry.apply(ON);
  dummyProbe.api!.status.set({ priority: BAND.ACTIVE, text: "dummy status" });
  fold();
  calls.invoke.length = 0;
});

describe("pinned line", { timeout: 30_000 }, () => {
  it("shows over an agent working line (30), beside other pills", () => {
    P.sa!.set({ priority: 1, text: "A pinned" });
    expect(line()?.text).toBe("dummy status");
    P.a!.status.pin("line", true);
    expect(State.settings.pinnedLine).toBe("srca.line");
    expect(line()?.text).toBe("A pinned");
    expect(line()?.priority).toBe(BAND.PINNED);
    expect(saves()).toContainEqual({ pinnedLine: "srca.line" });
  });

  it("voice 40, timer 50, a notice 60 and an urgent 90 pass over it; then it returns", async () => {
    P.sa!.set({ priority: 1, text: "A pinned" });
    P.a!.status.pin("line", true);
    const d = dummyProbe.api!;
    for (const p of [40, 50]) { d.status.set({ priority: p, text: `p${p}`, overGrid: true }); expect(line()?.text).toBe(`p${p}`); }
    d.status.set({ priority: 90, text: "urgent" });
    expect(line()?.text).toBe("urgent");
    d.status.set({ priority: BAND.ACTIVE, text: "dummy status" });
    expect(line()?.text).toBe("A pinned");
    const off = d.island.notice({ text: "aviso", ms: 2000 });
    await vi.advanceTimersByTimeAsync(100); // the presence answer
    expect(line()?.text).toBe("aviso");
    await vi.advanceTimersByTimeAsync(2500);
    off();
    expect(line()?.text).toBe("A pinned");
  });

  it("only one at a time: pinning another replaces it", () => {
    P.sa!.set({ priority: 1, text: "A line" });
    P.sb!.set({ priority: 1, text: "B line" });
    P.a!.status.pin("line", true);
    P.b!.status.pin("line", true);
    expect(State.settings.pinnedLine).toBe("srcb.line");
    expect(P.a!.status.pinned("line")).toBe(false);
    expect(P.b!.status.pinned("line")).toBe(true);
    expect(line()?.text).toBe("B line");
    P.b!.status.pin("line", false);
    expect(State.settings.pinnedLine).toBe("");
    expect(line()?.text).toBe("dummy status");
  });

  it("a click on the compact island opens the source's view", () => {
    P.sa!.set({ priority: 1, text: "A pinned" });
    P.a!.status.pin("line", true);
    (island as unknown as { clickCompact(): void }).clickCompact();
    tick(50);
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe("sa-view");
  });

  it("draws the icon and honours dim", () => {
    P.sa!.set({ priority: 1, text: "23°C", icon: "☀️", dim: true });
    P.a!.status.pin("line", true);
    expect((island as unknown as { compactLine(): string }).compactLine()).toBe("☀️ 23°C");
    expect(line()?.dim).toBe(true);
  });

  it("no content for 5 minutes releases the pin by itself; content in between cancels the timer", () => {
    P.a!.status.pin("line", true);
    tick(PIN_RELEASE_MS - 1000);
    expect(State.settings.pinnedLine).toBe("srca.line");
    P.sa!.set({ priority: 1, text: "back" });
    tick(PIN_RELEASE_MS);
    expect(State.settings.pinnedLine).toBe("srca.line");
    P.sa!.set(null);
    tick(PIN_RELEASE_MS + 10);
    expect(State.settings.pinnedLine).toBe("");
    expect(saves()).toContainEqual({ pinnedLine: "" });
  });

  it("a pinned source with content arms no timer at all", () => {
    P.sa!.set({ priority: 1, text: "A" });
    const before = vi.getTimerCount();
    P.a!.status.pin("line", true);
    expect(vi.getTimerCount()).toBe(before);
  });

  it("module off: the line is gone, the pin is kept, and it comes back with the module", () => {
    P.sa!.set({ priority: 1, text: "A pinned" });
    P.a!.status.pin("line", true);
    Registry.apply({ dummy: true, srca: false, srcb: true });
    expect(line()?.text).toBe("dummy status");
    expect(State.settings.pinnedLine).toBe("srca.line");
    tick(PIN_RELEASE_MS + 10); // absent source: no release timer either
    expect(State.settings.pinnedLine).toBe("srca.line");
    Registry.apply(ON);
    P.sa!.set({ priority: 1, text: "A again" });
    expect(line()?.text).toBe("A again");
  });
});

describe("with real pills", () => {
  const addPills = () => {
    P.a!.pills.set({ id: "pa", label: "A", color: "#88aaff", mood: "alert", badge: { text: "1" } as never });
    P.b!.pills.set({ id: "pb", label: "B", color: "#ffaa88", mood: "idle" });
    P.b!.pills.focus("pb"); // another pill is in front: the alert one is "other"
  };
  it("an approval / question / finished line shows over the pinned line even beside other non-ambient pills", () => {
    addPills();
    expect(State.otherPills.some((p) => !p.ambient)).toBe(true);
    P.sa!.set({ priority: 1, text: "A pinned" });
    P.a!.status.pin("line", true);
    expect(line()?.text).toBe("A pinned");
    const d = dummyProbe.api!;
    d.status.set({ priority: 100, text: "Aprovar?", urgent: true });
    expect(line()?.text).toBe("Aprovar?");
    d.status.set({ priority: 90, text: "Pergunta", urgent: true });
    expect(line()?.text).toBe("Pergunta");
    d.status.set({ priority: 60, text: "pronto" });
    expect(line()?.text).toBe("pronto");
    d.status.set({ priority: 40, text: "voz" });
    expect(line()?.text).toBe("voz");
    d.status.set({ priority: BAND.ACTIVE, text: "dummy status" });
    expect(line()?.text).toBe("A pinned");
    P.a!.pills.remove("pa");
    P.b!.pills.remove("pb");
  });
});

describe("last-opened line and the focus time", () => {
  it("ends after the focus time even when the island never hides", () => {
    dummyProbe.api!.status.set(null);
    State.settings.compactHideInterval = 0; // never hides: focus time 60 s
    island.applySettings();
    P.sa!.set({ priority: 1, text: "A last" });
    island.open("sa-view"); tick(10);
    fold();
    expect(line()?.text).toBe("A last");
    tick(59_000);
    expect(line()?.text).toBe("A last");
    tick(2_000);
    expect(line()).toBeNull();
    State.settings.compactHideInterval = 60;
    island.applySettings();
  });
});

describe("core keys", () => {
  it("a module cannot write pinnedLine through its settings", async () => {
    await expect(moduleSettings("x", { pinnedLine: "" }).save({ pinnedLine: "x.y" })).rejects.toThrow(/read-only/);
  });
});

describe("last-opened line", () => {
  beforeEach(() => dummyProbe.api!.status.set(null));

  it("appears after leaving that module's view, only below working lines, and ends when the island hides", () => {
    P.sa!.set({ priority: 99, text: "A last" });
    expect(line()).toBeNull();
    island.open("sa-view"); tick(10);
    fold();
    expect(line()?.text).toBe("A last");
    expect(line()?.priority).toBeLessThan(BAND.ACTIVE);
    dummyProbe.api!.status.set({ priority: BAND.ACTIVE, text: "work" });
    expect(line()?.text).toBe("work");
    dummyProbe.api!.status.set(null);
    island.hide(); tick(100);
    expect(State.mode).toBe("hidden");
    expect(line()).toBeNull();
  });

  it("is the last module opened; a pinned line beats it", () => {
    P.sa!.set({ priority: 1, text: "A last" });
    P.sb!.set({ priority: 1, text: "B last" });
    island.open("sa-view"); tick(10);
    island.setView("sb-view"); tick(10);
    fold();
    expect(line()?.text).toBe("B last");
    P.a!.status.pin("line", true);
    P.sa!.set({ priority: 1, text: "A pinned" });
    expect(line()?.text).toBe("A pinned");
  });

  it("a module without content shows nothing", () => {
    island.open("sa-view"); tick(10);
    fold();
    expect(line()).toBeNull();
  });
});
