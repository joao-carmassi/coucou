// timerGlance: while a timer runs, every focus time a short peek with the remaining time, even with the island hidden.
// Exactly one scoped timeout, re-armed after each fire, gone when the timer stops or the module is switched off.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { timerModule } from "../../src/modules/timer";
import manifest from "../../src/modules/timer/manifest.json";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const click = async (text: string) => {
  await tick(1100); // the view redraws on its next sync
  [...document.querySelectorAll<HTMLElement>("button")].find((e) => e.textContent === text)!.click();
};
const startTimer = async () => {
  island.open("timer");
  await tick(10);
  await click("5 min");
  await click("Iniciar");
};
const stopTimer = async () => {
  island.open("timer");
  await tick(10);
  await click("Cancelar");
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [timerModule], buildCatalog([manifest], true));
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  Registry.apply({ timer: false });
  State.settings.compactHideInterval = 30;
  State.settings.timerGlance = false;
  Registry.apply({ timer: true });
  island.applySettings();
});

describe("timer glance", () => {
  it("arms exactly one timeout more than without it, and clears it when the timer stops", async () => {
    // Only timeouts of the (distinctive) focus time count: other timers coming and going cannot flake this.
    State.settings.compactHideInterval = 37;
    island.applySettings();
    const set = vi.spyOn(window, "setTimeout");
    const clr = vi.spyOn(window, "clearTimeout");
    const live = () => {
      const ids = set.mock.calls.map((c, i) => (c[1] === 37_000 ? set.mock.results[i].value : null)).filter((v) => v !== null);
      return ids.filter((id) => !clr.mock.calls.some((c) => c[0] === id)).length;
    };
    try {
      await startTimer();
      island.collapse();
      await tick(100);
      const without = live();
      await stopTimer();
      island.collapse();
      State.settings.timerGlance = true;
      await startTimer();
      island.collapse();
      await tick(100);
      expect(live()).toBeGreaterThanOrEqual(without + 1);
      const armed = live();
      await stopTimer();
      island.collapse();
      await tick(100);
      expect(live()).toBeLessThan(armed);
    } finally {
      set.mockRestore();
      clr.mockRestore();
    }
  });

  it("peeks with the remaining time every focus time, even hidden, and re-arms after each fire", async () => {
    State.settings.timerGlance = true;
    const spy = vi.spyOn(island, "addNotice");
    const glances = () => spy.mock.calls.filter((c) => c[1].key === "timer-glance").length;
    await startTimer();
    island.hide();
    await tick(500);
    expect(State.mode).toBe("hidden");
    await tick(30_000);
    expect(State.mode).toBe("compact");
    await tick(100); // the presence answer
    expect(State.statusLine?.text).toMatch(/^0[0-5]:\d\d/);
    await tick(10_000); // the notice is gone, the island folds away again
    await tick(31_000);
    expect(glances()).toBe(2); // fired, re-armed, fired again
    spy.mockRestore();
    await stopTimer();
    island.hide();
    await tick(500);
    await tick(120_000);
    expect(State.mode).toBe("hidden"); // stopped: no more peeks
  });

  it("off by default: no peek, and the module stopping clears the timeout", async () => {
    await startTimer();
    island.hide();
    await tick(500);
    await tick(60_000);
    expect(State.mode).toBe("hidden");
    State.settings.timerGlance = true;
    Registry.apply({ timer: false });
    Registry.apply({ timer: true });
    await startTimer();
    const n = vi.getTimerCount();
    Registry.apply({ timer: false });
    expect(vi.getTimerCount()).toBeLessThan(n);
    await tick(120_000);
    expect(State.statusLine).toBeNull();
  });
});
