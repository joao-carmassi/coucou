// The module API's last doors: pills.focus, paused/onPause, settings/saveSettings. Two Rust-less modules, one island.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyProbe, otherProbe } from "./dummyModule";

const loadModules = async () => {
  const { dummyModule, otherModule } = await import("./dummyModule");
  return { MODULES: [dummyModule, otherModule] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "dummy", label: "Dummy", default: true, order: 1, settingsDefaults: { dummyGreeting: "hi", dummyList: [] } },
      { id: "other", label: "Other", default: true, order: 2 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

const dummy = () => dummyProbe.api!;
const other = () => otherProbe.api!;
const patches = () => calls.invoke.filter((c) => c.cmd === "save_settings").map((c) => (c.args as { patch: unknown }).patch);

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, other: true });
});
afterAll(() => vi.useRealTimers());

describe("api.pills.focus", () => {
  it("the first pill is in front; a module cannot focus another module's pill", () => {
    expect(State.focusId).toBe("dummy-pill");
    other().pills.focus("dummy-pill"); // not its own
    dummy().pills.focus("other-pill");
    expect(State.focusId).toBe("dummy-pill");
  });

  it("a module focuses its own pill, and release gives the front back", () => {
    const release = other().pills.focus("other-pill");
    expect(State.focusId).toBe("other-pill");
    release();
    expect(State.focusId).toBe("dummy-pill");
  });

  it("the pill being opened may be focused by whoever reacts", () => {
    dummy().provide("pillOpen", (id) => (dummy().pills.focus(id), true));
    other().call("pillOpen", "other-pill");
    expect(State.focusId).toBe("other-pill");
    dummy().pills.focus("dummy-pill");
  });

  it("when the front pill is removed the core moves focus to the first one left", () => {
    dummy().pills.remove("dummy-pill");
    expect(State.focusId).toBe("other-pill");
    other().pills.remove("other-pill");
    expect(State.focusId).toBeNull();
  });
});

describe("pause", () => {
  it("onPause fires with each change, once, and stops when disposed", () => {
    const seen: boolean[] = [];
    const off = dummy().onPause((p) => seen.push(p));
    expect(dummy().paused()).toBe(false);
    State.setPaused(true);
    State.setPaused(true);
    expect(dummy().paused()).toBe(true);
    State.setPaused(false);
    off();
    State.setPaused(true);
    expect(seen).toEqual([true, false]);
    State.setPaused(false);
  });
});

describe("module settings", () => {
  it("settings() is a read-only snapshot of the declared keys with their defaults", () => {
    const s = dummy().settings<{ dummyGreeting: string; dummyList: string[] }>();
    expect(s).toEqual({ dummyGreeting: "hi", dummyList: [] });
    expect(() => { (s as { dummyGreeting: string }).dummyGreeting = "x"; }).toThrow();
    expect(other().settings()).toEqual({});
  });

  it("saveSettings sends only the given keys, and settings() has them at once", async () => {
    (State.settings as unknown as Record<string, unknown>).unrelated = "keep";
    await dummy().saveSettings({ dummyGreeting: "oi" });
    expect(patches().at(-1)).toEqual({ dummyGreeting: "oi" });
    expect(dummy().settings()).toEqual({ dummyGreeting: "oi", dummyList: [] });
    expect((State.settings as unknown as Record<string, unknown>).unrelated).toBe("keep");
  });

  it("a key the module did not declare is refused (rejected promise, never a sync throw)", async () => {
    const n = patches().length;
    let p: Promise<void> | undefined;
    expect(() => { p = dummy().saveSettings({ soundVolume: 1 }); }).not.toThrow();
    await expect(p).rejects.toThrow(/not declared/);
    await expect(other().saveSettings({ dummyGreeting: "x" })).rejects.toThrow(/not declared/);
    expect(patches()).toHaveLength(n);
  });
});
