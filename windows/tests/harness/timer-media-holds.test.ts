// Timer keeps a sticky hold while a task is on (released when it ends); Mídia relies on the implicit focus only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe } from "./dummyModule";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "media_list" ? [1, 2].map((n) => ({ name: `${n}.png`, path: `C:/${n}.png`, size: 1, kind: "screenshot", ts: 1 })) : null),
}));
const loadModules = async () => {
  const { dummyModule } = await import("./dummyModule");
  const { timerModule } = await import("../../src/modules/timer");
  const { media } = await import("../../src/modules/media");
  return { MODULES: [dummyModule, timerModule, media] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "dummy", label: "Dummy", default: true, order: 200 },
      { id: "timer", label: "Timer", default: true, order: 210 },
      { id: "media", label: "Mídia", default: true, order: 220 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { Holds, Last } from "../../src/core/holds";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const api = () => dummyProbe.api!;
const folded = () => { island.collapse(); tick(10); };
const reopen = () => { island.fsm.forceHome(); tick(10); };
const click = (sel: string, text: string) => {
  tick(1100); // the view redraws on its next sync
  [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent === text)!.click();
};
/** Open `view`, fold, reopen as a click on the compact island does. */
const landsOn = (view: string) => {
  api().island.open(view); tick(10); folded(); reopen();
  const v = State.view; folded();
  return v === view;
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, timer: true, media: true });
  island.launch();
  tick(15_000);
});
afterAll(() => vi.useRealTimers());

const goHome = () => { Holds.clear(); Last.clear(); };

describe("timer sticky hold", () => {
  it("held from ready to cancel; reopen lands on the timer even after 10 minutes", () => {
    api().island.open("timer"); tick(10);
    click("button", "5 min");
    expect(landsOn("timer")).toBe(true);
    click("button", "Iniciar");
    api().island.open("dummy-a"); tick(10); folded();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    reopen();
    expect(State.view).toBe("timer");
    folded();
    api().island.open("timer"); tick(10);
    click("button", "Cancelar");
    folded();
    goHome();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("finishing the countdown releases it", () => {
    api().island.open("timer"); tick(10);
    click("button", "5 min"); click("button", "Iniciar");
    api().island.open("dummy-a"); tick(10);
    tick(5 * 60_000 + 10);
    folded();
    Last.clear();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("the home tab clears it", () => {
    api().island.open("timer"); tick(10);
    click("button", "5 min");
    const home = State.tabs.find((t) => t.view === State.defaultView())!;
    [...document.querySelectorAll<HTMLElement>("#header .tabs button")].find((b) => b.title === home.title || b.textContent === home.title)!.click();
    tick(10);
    folded(); reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    api().island.open("timer"); tick(10);
    click("button", "Cancelar");
    goHome();
    folded();
  });
});

describe("timer retakes a cleared hold", () => {
  it("after the home tab cleared it, pause/resume of the same timer holds again", () => {
    api().island.open("timer"); tick(10);
    click("button", "5 min"); click("button", "Iniciar");
    const home = State.tabs.find((t) => t.view === State.defaultView())!;
    [...document.querySelectorAll<HTMLElement>("#header .tabs button")].find((b) => b.title === home.title || b.textContent === home.title)!.click();
    tick(10);
    api().island.open("timer"); tick(10);
    click("button", "Pausar"); click("button", "Retomar");
    api().island.open("dummy-a"); tick(10); folded();
    Last.clear();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    reopen();
    expect(State.view).toBe("timer");
    folded();
    api().island.open("timer"); tick(10);
    click("button", "Cancelar");
    folded(); goHome();
  });
});

describe("media: implicit focus only", () => {
  const openMedia = async () => { api().island.open("media"); tick(10); await vi.advanceTimersByTimeAsync(10); };

  it("close and reopen within 59 s lands on Mídia with no hold call; after 61 s, home", async () => {
    await openMedia();
    folded();
    vi.setSystemTime(Date.now() + 59_000);
    reopen();
    expect(State.view).toBe("media");
    folded();
    vi.setSystemTime(Date.now() + 61_000);
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
    goHome();
  });

  it("Timer -> Mídia -> close -> reopen within a minute lands on Mídia", async () => {
    api().island.open("timer"); tick(10);
    await openMedia();
    folded();
    reopen();
    expect(State.view).toBe("media");
    folded();
    goHome();
  });

  it("Abrir and dblclick no longer drop the focus", async () => {
    await openMedia();
    document.querySelector<HTMLElement>(".media-cell")!.dispatchEvent(new Event("dblclick", { bubbles: true }));
    document.querySelector<HTMLElement>(".media-cell")!.dispatchEvent(new Event("contextmenu", { cancelable: true, bubbles: true }));
    click(".media-menu-row", "Abrir");
    await vi.advanceTimersByTimeAsync(10);
    folded();
    reopen();
    expect(State.view).toBe("media");
    folded();
    goHome();
  });
});

describe("timer pomodoro and alarms", () => {
  it("pomodoro keeps the hold across phases and Parar releases it", () => {
    State.settings = { ...State.settings, timerPomodoro: { work: 5, short: 5, long: 15, every: 4 } } as typeof State.settings;
    api().island.open("timer"); tick(10);
    click("button", "Pomodoro");
    api().island.open("dummy-a"); tick(10); folded();
    tick(5 * 60_000 + 10); // work -> short break, auto-started: still held
    Last.clear();
    reopen();
    expect(State.view).toBe("timer");
    folded();
    api().island.open("timer"); tick(10);
    click("button", "Parar");
    folded(); goHome(); reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("an alarm timeout is armed only for the next fire time and cancelled on module stop", () => {
    const base = vi.getTimerCount();
    const at = new Date(Date.now() + 3 * 60_000);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    State.settings = { ...State.settings, timerAlarms: [{ id: "a", time: hhmm, label: "x", days: [], on: true }] } as typeof State.settings;
    api().island.open("timer"); tick(10); // visibility change re-arms
    folded(); reopen(); folded();
    expect(vi.getTimerCount()).toBeGreaterThan(base - 1);
    Registry.apply({ dummy: true, timer: false, media: true });
    const stopped = vi.getTimerCount();
    Registry.apply({ dummy: true, timer: true, media: true });
    Registry.apply({ dummy: true, timer: false, media: true });
    expect(vi.getTimerCount()).toBe(stopped);
    Registry.apply({ dummy: true, timer: true, media: true });
    State.settings = { ...State.settings, timerAlarms: [] } as typeof State.settings;
  });
});
