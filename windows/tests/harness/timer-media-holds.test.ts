// Timer and Mídia take a task hold (api.island.hold) while a task is on, and release it when it ends.
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

describe("timer hold", () => {
  it("held from ready to cancel; reopen lands on the timer", () => {
    api().island.open("timer"); tick(10);
    click("button", "5 min");
    expect(landsOn("timer")).toBe(true);
    click("button", "Iniciar");
    expect(landsOn("timer")).toBe(true);
    api().island.open("timer"); tick(10);
    click("button", "Cancelar");
    folded();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("finishing the countdown releases it", () => {
    api().island.open("timer"); tick(10);
    click("button", "5 min"); click("button", "Iniciar");
    tick(5 * 60_000 + 10);
    folded();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });
});

describe("media hold", () => {
  const openMedia = async () => { api().island.open("media"); tick(10); await vi.advanceTimersByTimeAsync(10); };

  it("held while the view is on; reopen lands on media", async () => {
    await openMedia();
    expect(landsOn("media")).toBe(true);
  });

  it("dblclick open releases it", async () => {
    await openMedia();
    document.querySelector<HTMLElement>(".media-cell")!.dispatchEvent(new Event("dblclick", { bubbles: true }));
    folded();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });

  it("'Remover da lista' keeps it; 'Abrir' releases it", async () => {
    api().island.setView("dummy-a"); tick(1100); // the view syncs while open
    await openMedia();
    const menu = () => document.querySelector<HTMLElement>(".media-cell")!.dispatchEvent(new Event("contextmenu", { cancelable: true, bubbles: true }));
    menu();
    click(".media-menu-row", "Remover da lista");
    await vi.advanceTimersByTimeAsync(10);
    expect(landsOn("media")).toBe(true);
    await openMedia();
    menu();
    click(".media-menu-row", "Abrir");
    await vi.advanceTimersByTimeAsync(10);
    folded();
    reopen();
    expect(State.view).toBe(State.defaultView());
    folded();
  });
});
