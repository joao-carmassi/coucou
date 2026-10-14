// Home: the board owns it when it is on; Claude (the real module) draws its own when the board is off.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/modules/index", async () => {
  const { board } = await import("../../src/modules/board");
  const { claude } = await import("../../src/modules/claude");
  return { MODULES: [board, claude] };
});
vi.mock("../../src/modules/catalog", async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "board", label: "Painel", default: true, order: 0 },
      { id: "claude", label: "Claude", default: true, order: 1 },
    ], true),
  };
});

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);

beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island);
  island.launch();
});
afterAll(() => vi.useRealTimers());

describe("home", () => {
  it("claude without the board: claude-home, with the Claude card", () => {
    Registry.apply({ board: false, claude: true });
    tick(15_000);
    expect(State.defaultView()).toBe("claude-home");
    island.open("claude-home");
    tick(100);
    expect(State.view).toBe("claude-home");
    expect(document.querySelector(".overview.solo .left-body .tile-card .tile-head span")?.textContent).toBe("Integração");
    expect(document.querySelector("[data-tab='overview']")).toBeNull();
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

  it("both off: empty", () => {
    Registry.apply({ board: false, claude: false });
    tick(100);
    expect(State.defaultView()).toBe("empty");
    expect(State.tabs).toHaveLength(0);
  });
});
