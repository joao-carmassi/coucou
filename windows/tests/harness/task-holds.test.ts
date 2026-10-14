// Task holds adopted by the modules (sessions list, upload choice, GitHub sheet), driven through the real island:
// reopening by every path (click outside, auto-close, compact hide; hover/click/hotkey) lands on the held view.
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
import { Holds } from "../../src/core/holds";

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

describe("sessions hold", () => {
  const enter = async () => { dummyProbe.api!.island.open("sessions"); tick(10); await settle(); };
  const leave = async () => { dummyProbe.api!.island.open("dummy-a"); tick(10); await settle(); folded(); Holds.clear(); };

  it("taken on enter; survives click-outside and reopen", async () => {
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

  it("reopens again after being left a second time (touched on leave)", async () => {
    await enter();
    folded(); reopen(); folded(); reopen();
    expect(lands()).toBe("sessions");
    await leave();
  });

  it("expires one minute after the view left the screen", async () => {
    await enter();
    folded();
    vi.setSystemTime(Date.now() + 61_000);
    reopen();
    expect(lands()).toBe(State.defaultView());
    await leave();
  });

  it("released by opening an old session (Retomar)", async () => {
    await enter();
    document.querySelector<HTMLElement>(".sess-act")!.click();
    await settle(50);
    folded();
    reopen();
    expect(lands()).toBe(State.defaultView());
    await leave();
  });

  it("held again on the next visit after a conclusion", async () => {
    await enter();
    folded(); reopen();
    expect(lands()).toBe("sessions");
    await leave();
  });

  it("released by 'Nova sessão'", async () => {
    await enter();
    document.querySelector<HTMLElement>(".sess-newbtn")!.click();
    await settle(50);
    folded(); reopen();
    expect(lands()).toBe(State.defaultView());
    await leave();
  });

  it("the claude hotkey with nothing pending reopens a folded island on the held view", async () => {
    await enter();
    folded();
    handlers["go-to-alert"]?.({ payload: null });
    tick(10);
    expect(lands()).toBe("sessions");
    await leave();
  });
});

describe("upload choice hold", () => {
  const drop = async () => {
    handlers["file-drag"]({ payload: { type: "enter" } });
    tick(50);
    handlers["file-drag"]({ payload: { type: "drop", paths: ["C:/f.txt"] } });
    await settle(8000);
  };

  it("held while the choose card waits; released by cancel", async () => {
    await drop();
    expect(State.view).toBe("choose");
    folded(); reopen();
    expect(State.view).toBe("choose");
    press("Cancelar");
    tick(10);
    folded(); reopen();
    expect(lands()).toBe(State.defaultView());
  });

  it("released by choosing the action", async () => {
    await drop();
    expect(State.view).toBe("choose");
    press("Abrir no Claude Code");
    await settle(50);
    folded(); reopen();
    expect(lands()).toBe(State.defaultView());
  });
});

describe("github sheet hold", () => {
  it("held while a sheet is open; released when the panel starts over", async () => {
    const { enterGithubPanel } = await import("../../src/modules/integrations/views/github");
    dummyProbe.api!.island.open("github"); tick(10);
    enterGithubPanel({ target: { kind: "project", repo: "a/b" }, label: "b", url: "https://github.com/a/b" });
    await settle();
    folded(); reopen();
    expect(State.view).toBe("github");
    enterGithubPanel();
    folded(); reopen();
    expect(lands()).toBe(State.defaultView());
  });
});
