// Board primary against the REAL claude module: a folded revert must not open the island through Claude's focus service.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IslandApi, ModuleDef } from "../../src/core/moduleApi";
import type { BoardFocus } from "../../src/modules/board/api";

const T = vi.hoisted(() => ({ claude: null as unknown, alpha: null as IslandApi | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../../src/modules/claude/claude", async (orig) => {
  const real = await orig<typeof import("../../src/modules/claude/claude")>();
  return { ...real, claudeOf: (api: never) => ((T.claude = real.claudeOf(api)), T.claude) };
});

const loadModules = async () => {
  const { board } = await import("../../src/modules/board");
  const { claude } = await import("../../src/modules/claude");
  const alpha: ModuleDef = {
    id: "alpha",
    start(api) {
      T.alpha = api;
      api.pills.set({ id: "alpha-pill", label: "Alpha", color: "#88aaff", mood: "idle" });
      const off = api.provide<BoardFocus>("board.focus", (id) => { if (id === "alpha-pill") api.pills.focus(id); });
      return () => { off(); T.alpha = null; };
    },
  } as ModuleDef;
  return [board, claude, alpha];
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { newSession } from "../../src/modules/claude/types";

let island: Island;
const ALL = { board: true, claude: true, alpha: true };
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const cl = () => T.claude as import("../../src/modules/claude/claude").Claude;
const front = () => State.focusPill?.id;
const fold = () => { island.collapse(); tick(10); };
const reopen = () => { island.fsm.forceHome(); tick(100); };
const pickAlpha = () => { reopen(); [...document.querySelectorAll<HTMLElement>(".pill")].find((p) => p.textContent === "Alpha")!.click(); tick(100); };
const approval = (id: string) => ({ requestId: id, sessionId: "s1", tool: "Bash", command: "ls", proposal: null, plan: null });

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  const { buildCatalog } = await import("../../src/modules/resolve");
  const manifest = (await import("../../src/modules/board/manifest.json")).default;
  Registry.init(island, await loadModules(), buildCatalog([
    manifest, { id: "claude", label: "Claude", default: true, order: 1 }, { id: "alpha", label: "Alpha", default: true, order: 2 },
  ], true));
  Registry.apply(ALL);
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  Registry.apply({ ...ALL, board: false });
  Registry.apply(ALL);
  Object.assign(State.settings, { boardPrimary: "claude", compactHideInterval: 60 });
  const s = newSession("s1");
  Object.assign(s, { project: "p", state: "working" });
  cl().store.sessions = [s];
  cl().store.frontId = "s1";
  cl().store.present();
  cl().syncRequest(false); // drops the request of the last test
  fold();
  vi.setSystemTime(new Date(2030, 0, 1));
});

describe("board primary with the real claude module", () => {
  it("a pending approval on the folded island: the revert puts Claude in front and does not open the island", () => {
    pickAlpha();
    fold();
    cl().store.session.approval = approval("r1");
    tick(61_000);
    expect(front()).toBe("integration_claude");
    expect(State.mode).not.toBe("expanded");
  });

  it("a pinned/parked request (quiet) is present: still reverts, island not opened", () => {
    pickAlpha();
    fold();
    cl().store.session.approval = approval("r2");
    cl().syncRequest(false); // queued and pinned, the screen is not taken
    tick(10);
    expect(State.mode).not.toBe("expanded");
    tick(61_000);
    expect(front()).toBe("integration_claude");
    expect(State.mode).not.toBe("expanded");
  });

  it("a session waiting behind the front one: the revert does not open the island", () => {
    pickAlpha();
    fold();
    const w = newSession("s2");
    w.approval = approval("r3");
    cl().store.sessions.push(w);
    tick(61_000);
    expect(front()).toBe("integration_claude");
    expect(State.mode).not.toBe("expanded");
  });

  it("a click on Claude while open still brings its pending card", () => {
    cl().store.session.approval = approval("r4");
    reopen();
    [...document.querySelectorAll<HTMLElement>(".pill")].find((p) => p.textContent === "Alpha")!.click(); tick(100);
    [...document.querySelectorAll<HTMLElement>(".pill")].find((p) => p.textContent !== "Alpha")!.click(); tick(100);
    expect(State.view).toBe("approval");
  });
});

describe("Y/N on the approval card", () => {
  const press = (key: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  it("ignored right after the card appears and right after the palette, honored later, never in a text field", () => {
    const decide = vi.spyOn(cl(), "decide").mockImplementation(() => {});
    cl().store.session.approval = approval("r9");
    cl().syncRequest(true);
    reopen();
    tick(10);
    expect(State.view).toBe("approval");
    press("y");
    expect(decide).not.toHaveBeenCalled();
    tick(600);
    const input = document.body.appendChild(document.createElement("input"));
    press("y", input);
    expect(decide).not.toHaveBeenCalled();
    input.remove();
    // the palette had the keyboard a moment ago
    State.view = "palette";
    press("a");
    State.view = "approval";
    tick(100);
    press("y");
    expect(decide).not.toHaveBeenCalled();
    tick(1600);
    press("y");
    expect(decide).toHaveBeenCalledWith("allow");
    decide.mockRestore();
  });
});
