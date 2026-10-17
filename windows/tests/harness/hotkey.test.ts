// The global hotkey opens the island on the home view; keyboard navigation and Alt+<key>, through the real island.
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
  island.open("dummy-b");
  await tick(100);
  island.collapse();
  await tick(600);
  calls.invoke.length = 0;
});

describe("hotkey", () => {
  it("opens the home view expanded and takes the keyboard; Esc folds", async () => {
    island.openFromHotkey();
    await tick(100);
    expect(State.mode).toBe("expanded");
    expect(State.view).toBe(State.defaultView());
    expect(focusCalls()).toContain(true);
    key("Escape");
    await tick(600);
    expect(State.mode).toBe("compact");
  });

  it("Left/Right move between tabs, Enter clicks the card that opens", async () => {
    island.openFromHotkey();
    await tick(100);
    key("ArrowRight");
    await tick(100);
    expect(State.view).toBe("dummy-b");
    key("ArrowLeft");
    await tick(100);
    expect(State.view).toBe("dummy-a");
    const open = vi.fn();
    const card = document.querySelector("#views .view.on")!.appendChild(document.createElement("div"));
    card.className = "opens";
    card.addEventListener("click", open);
    key("Enter");
    expect(open).toHaveBeenCalledOnce();
    card.remove();
  });

  it("arrows do nothing when the island was not opened by the hotkey", async () => {
    island.open("dummy-a");
    await tick(100);
    key("ArrowRight");
    await tick(100);
    expect(State.view).toBe("dummy-a");
  });

  it("a pinned request blocks it", async () => {
    const off = a().island.request({ view: "dummy-b", priority: 50, pin: true });
    await tick(100);
    island.openFromHotkey();
    await tick(100);
    expect(State.view).toBe("dummy-b");
    off();
    await tick(100);
  });
});

describe("keys", () => {
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
});
