// Home: the board owns it when it is on; with it off there is no Início at all (first tab, else empty).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const { claude } = await import("../../src/modules/claude");
  return { MODULES: [board, claude] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "board", label: "Painel", default: true, order: 0 },
      { id: "claude", label: "Claude", default: true, order: 1 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  island.launch();
});
afterAll(() => vi.useRealTimers());

describe("home", () => {
  it("claude without the board: no Início, home is the first tab (Sessões)", () => {
    Registry.apply({ board: false, claude: true });
    tick(15_000);
    expect(State.defaultView()).not.toBe("overview");
    expect(State.defaultView()).not.toBe("empty");
    expect(State.tabs.some((t) => t.view === "overview")).toBe(false);
    island.open(State.defaultView());
    tick(100);
    expect(document.querySelector(".overview")).toBeNull();
  });

  it("the board on: overview is home", () => {
    Registry.apply({ board: true, claude: true });
    tick(100);
    expect(State.defaultView()).toBe("overview");
    island.open("overview");
    tick(100);
    expect(document.querySelector(".overview")).not.toBeNull();
    expect(document.querySelector(".left-body .tile-card")).not.toBeNull();
  });

  it("the board turned off while showing Início: the island leaves it", () => {
    Registry.apply({ board: true, claude: true });
    tick(100);
    island.open("overview");
    tick(100);
    expect(State.view).toBe("overview");
    Registry.apply({ board: false, claude: true });
    tick(100);
    expect(State.view).not.toBe("overview");
    expect(document.querySelector(".overview")).toBeNull();
  });

  it("both off: empty", () => {
    Registry.apply({ board: false, claude: false });
    tick(100);
    expect(State.defaultView()).toBe("empty");
    expect(State.tabs).toHaveLength(0);
  });
});
