// Implicit focus on the modules' views (no hold call), driven through the real island: reopening by every path
// (click outside, auto-close, compact hide; hover/click/hotkey) lands on the last tab; actions do not drop it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe } from "./dummyModule";

const handlers: Record<string, (p: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { path?: string }) => {
    if (cmd === "claude_sessions_all") return [{ profile: "p", id: "old", title: "Old", cwd: "C:/x", updated: 1, status: "idle" }];
    if (cmd === "inbox_ingest") return { name: "f.txt", path: args?.path ?? "", size: 1 };
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (p: { payload: unknown }) => void) => ((handlers[name] = fn), () => {}),
}));
const loadModules = async () => {
  const { dummyModule } = await import("./dummyModule");
  const { claude } = await import("../../src/modules/claude");
  const { uploadModule } = await import("../../src/modules/upload");
  const { github } = await import("../../src/modules/integrations");
  return { MODULES: [dummyModule, claude, uploadModule, github] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "dummy", label: "Dummy", default: true, order: 200 },
      { id: "claude", label: "Claude", default: true, order: 210 },
      { id: "upload", label: "Upload", default: true, order: 220 },
      { id: "github", label: "GitHub", default: true, order: 230 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State, DEFAULT_SETTINGS } from "../../src/core/state";
import { Holds, Last } from "../../src/core/holds";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const settle = async (ms = 1100) => { await vi.advanceTimersByTimeAsync(ms); };
const folded = () => { island.collapse(); tick(10); };
const reopen = () => { island.fsm.forceHome(); tick(10); };
const lands = () => { const v = State.view; folded(); return v; };
const press = (text: string) => [...document.querySelectorAll<HTMLElement>("#views button")].find((b) => b.textContent === text)!.click();

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, claude: true, upload: true, github: true });
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("defaults", () => {
  it("focus hold is one minute", () => expect(DEFAULT_SETTINGS.focusHoldMinutes).toBe(1));
});

const clearAll = () => { Holds.clear(); Last.clear(); };

describe("sessions: implicit focus", () => {
  const enter = async () => { dummyProbe.api!.island.open("sessions"); tick(10); await settle(); };
  const leave = async () => { dummyProbe.api!.island.open("dummy-a"); tick(10); await settle(); folded(); clearAll(); };

  it("survives click-outside and reopen", async () => {
    await enter();
    folded();
    reopen();
    expect(lands()).toBe("sessions");
    await leave();
  });

  it("survives auto-close and compact hide; hover + click reopens on it", async () => {
    await enter();
    island.fsm.petitToHiddenDelay = 20;
    tick(16_000); // auto-close
    expect(State.mode).toBe("compact");
    tick(21_000); // compact hide
    expect(State.mode).toBe("hidden");
    island.fsm.mouseEntered(); tick(10);
    island.fsm.click(); tick(10);
    expect(lands()).toBe("sessions");
    await leave();
  });

  it("lands within the focus time, goes home after it", async () => {
    await enter();
    folded();
    vi.setSystemTime(Date.now() + 59_000);
    reopen();
    expect(lands()).toBe("sessions");
    vi.setSystemTime(Date.now() + 61_000);
    reopen();
    expect(lands()).toBe(State.defaultView());
    await leave();
  });

  it("actions (Retomar, Nova sessão) no longer drop the focus", async () => {
    await enter();
    document.querySelector<HTMLElement>(".sess-act")!.click();
    await settle(50);
    document.querySelector<HTMLElement>(".sess-newbtn")!.click();
    await settle(50);
    folded(); reopen();
    expect(lands()).toBe("sessions");
    await leave();
  });

  it("the claude hotkey with nothing pending reopens a folded island on it", async () => {
    await enter();
    folded();
    handlers["go-to-alert"]?.({ payload: null });
    tick(10);
    expect(lands()).toBe("sessions");
    await leave();
  });
});

describe("home tab clears focus", () => {
  it("clicking the home tab drops the implicit focus; a sticky hold too", async () => {
    const release = dummyProbe.api!.island.hold("github");
    dummyProbe.api!.island.open("sessions"); tick(10); await settle();
    const home = State.tabs.find((t) => t.view === State.defaultView())!;
    [...document.querySelectorAll<HTMLElement>("#header .tabs button")].find((b) => b.title === home.title || b.textContent === home.title)!.click();
    tick(10);
    folded(); reopen();
    expect(lands()).toBe(State.defaultView());
    release(); clearAll();
  });

  it("automatic landing on home keeps a sticky hold", async () => {
    const release = dummyProbe.api!.island.hold("sessions");
    dummyProbe.api!.island.open("dummy-a"); tick(10);
    dummyProbe.api!.island.setView(State.defaultView()); tick(10);
    folded(); reopen();
    expect(lands()).toBe("sessions");
    release(); clearAll();
  });
});

describe("upload choose and github sheet: no hold of their own, actions keep focus", () => {
  const drop = async () => {
    handlers["file-drag"]({ payload: { type: "enter" } });
    tick(50);
    handlers["file-drag"]({ payload: { type: "drop", paths: ["C:/f.txt"] } });
    await settle(8000);
  };

  it("choose card: cancel goes home on its own (setView home), no stale hold", async () => {
    await drop();
    expect(State.view).toBe("choose");
    press("Cancelar");
    tick(10);
    clearAll();
    folded(); reopen();
    expect(lands()).toBe(State.defaultView());
  });

  it("github panel: implicit focus brings it back, opening in the browser does not drop it", async () => {
    const { enterGithubPanel } = await import("../../src/modules/integrations/views/github");
    dummyProbe.api!.island.open("github"); tick(10);
    enterGithubPanel({ target: { kind: "project", repo: "a/b" }, label: "b", url: "https://github.com/a/b" });
    await settle();
    folded(); reopen();
    expect(lands()).toBe("github");
    clearAll();
  });
});
