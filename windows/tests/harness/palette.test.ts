// The palette and the central key handler, driven through the real island.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyProbe } from "./dummyModule";
import { State } from "../../src/core/state";

const loadModules = async () => ({ MODULES: [(await import("./dummyModule")).dummyModule] });
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return { MODULE_INFO: buildCatalog([{ id: "dummy", label: "Dummy", default: true, order: 200 }], true) };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const a = () => dummyProbe.api!;
const key = (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
};
const input = () => document.querySelector<HTMLInputElement>("[data-palette]")!;
const type = (v: string) => { input().value = v; input().dispatchEvent(new Event("input")); };
const rows = () => [...document.querySelectorAll("#views .view.on .settings-rows > button")].map((b) => b.textContent);
const focusCalls = () => calls.invoke.filter((c) => c.cmd === "focus_window").map((c) => (c.args as { focused: boolean }).focused);

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<div id=\"root\"></div>";
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true });
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  island.open("dummy-a");
  await tick(100);
  island.collapse();
  await tick(600);
  calls.invoke.length = 0;
});

describe("palette", () => {
  it("opens from compact, takes the keyboard, filters, Enter runs and collapses back", async () => {
    const run = vi.fn();
    const off = a().actions.add({ id: "go", title: "Fazer coisa", run });
    island.openPalette();
    await tick(100);
    expect(State.view).toBe("palette");
    expect(focusCalls()).toContain(true);
    type("coisa");
    expect(rows()).toEqual(["Fazer coisa"]);
    key("Enter");
    expect(run).toHaveBeenCalledOnce();
    await tick(600);
    expect(State.mode).toBe("compact");
    off();
  });

  it("lists a go-to entry per tab; Enter goes there", async () => {
    island.openPalette();
    await tick(100);
    type("dummy-b");
    expect(rows()).toEqual(["Ir para dummy-b"]);
    key("Enter");
    await tick(100);
    expect(State.view).toBe("dummy-b");
  });

  it("Esc from an expanded view returns to it; from compact collapses", async () => {
    island.open("dummy-a");
    await tick(100);
    island.openPalette();
    await tick(100);
    const e = key("Escape");
    expect(e.defaultPrevented).toBe(true);
    await tick(100);
    expect(State.view).toBe("dummy-a");
    expect(State.mode).toBe("expanded");
    island.collapse();
    await tick(600);
    island.openPalette();
    await tick(100);
    key("Escape");
    await tick(600);
    expect(State.mode).toBe("compact");
  });

  it("a pinned request blocks it", async () => {
    const off = a().island.request({ view: "dummy-b", priority: 50, pin: true });
    await tick(100);
    island.openPalette();
    await tick(100);
    expect(State.view).toBe("dummy-b");
    key("k", { ctrlKey: true });
    expect(State.view).toBe("dummy-b");
    off();
    await tick(100);
  });

  it("Alt+key runs the action; Ctrl+Alt+key (AltGr) does nothing; repeat ignored", async () => {
    const run = vi.fn();
    const off = a().actions.add({ id: "k", title: "K", key: "k", run });
    key("k", { altKey: true, ctrlKey: true });
    key("k", { altKey: true, repeat: true });
    expect(run).not.toHaveBeenCalled();
    key("k", { altKey: true });
    expect(run).toHaveBeenCalledOnce();
    off();
    key("k", { altKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it("an action that rejects reaches the island error", async () => {
    const err = vi.spyOn(island, "error");
    const off = a().actions.add({ id: "bad", title: "Bad", key: "b", run: () => Promise.reject(new Error("x")) });
    key("b", { altKey: true });
    await tick(10);
    expect(err).toHaveBeenCalled();
    off();
  });

  it("Ctrl+Tab cycles the tabs while expanded", async () => {
    island.open("dummy-a");
    await tick(100);
    key("Tab", { ctrlKey: true });
    await tick(100);
    expect(State.view).toBe("dummy-b");
    key("Tab", { ctrlKey: true, shiftKey: true });
    await tick(100);
    expect(State.view).toBe("dummy-a");
  });

  it("a module's own y handler does not fire from the palette", async () => {
    const fired = vi.fn();
    const handler = (e: KeyboardEvent) => { if (e.key === "y" && a().island.view() === "dummy-a") fired(); };
    window.addEventListener("keydown", handler);
    island.openPalette();
    await tick(100);
    key("y");
    expect(fired).not.toHaveBeenCalled();
    window.removeEventListener("keydown", handler);
  });
});
