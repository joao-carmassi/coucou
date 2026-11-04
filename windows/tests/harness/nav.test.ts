// Mouse side buttons (back = 3, forward = 4) walk the open island's history, through the real island and the dummy module.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe, requestPin } from "./dummyModule";

const loadModules = async () => {
  const { dummyModule } = await import("./dummyModule");
  return { MODULES: [dummyModule] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return { MODULE_INFO: buildCatalog([{ id: "dummy", label: "Dummy", default: true, order: 200 }], true) };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

let island: Island;
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const api = () => dummyProbe.api!;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true });
  island.launch();
  tick(15_000); // greeting -> compact
});
afterAll(() => vi.useRealTimers());

const open = (view: string) => { island.open(view); tick(2000); };
const folded = () => { island.collapse(); tick(2000); };
const tab = (view: string) => (document.querySelector(`.tab[title="${view}"]`) as HTMLElement).click();
/** A mouse button released over the island (x 360 is the window's middle, y 20 is inside the open island). */
const release = (button: number, x = 360, y = 20) => {
  const e = new MouseEvent("mouseup", { button, clientX: x, clientY: y, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

describe("back and forward", () => {
  it("a tab change goes back with button 3 and forward with button 4", () => {
    open("dummy-a");
    tab("dummy-b");
    expect(State.view).toBe("dummy-b");
    const back = release(3);
    expect(back.defaultPrevented).toBe(true);
    expect(State.view).toBe("dummy-a");
    expect(release(4).defaultPrevented).toBe(true);
    expect(State.view).toBe("dummy-b");
    release(4); // end of the history
    expect(State.view).toBe("dummy-b");
    folded();
  });

  it("the views the module sets on its own are not recorded", () => {
    open("dummy-a");
    api().island.setView("dummy-b");
    tick(10);
    expect(State.view).toBe("dummy-b");
    release(3); // nothing before: the screen moved unrecorded, so back is the entry it left
    expect(State.view).toBe("dummy-a");
    release(3);
    expect(State.view).toBe("dummy-a");
    folded();
  });

  it("collapse and reopen start a new history", () => {
    open("dummy-a");
    tab("dummy-b");
    folded();
    open("dummy-b");
    release(3);
    expect(State.view).toBe("dummy-b");
    folded();
  });

  it("a pinned request ignores the side buttons", () => {
    open("dummy-a");
    tab("dummy-b");
    const off = requestPin(api(), "dummy-a", 0);
    tick(10);
    expect(State.isPinned).toBe(true);
    release(3);
    expect(State.view).toBe("dummy-a"); // the request's view, not a step back
    off();
    folded();
  });

  it("a release outside the island does nothing", () => {
    open("dummy-a");
    tab("dummy-b");
    release(3, 360, 900);
    release(3, 5, 20);
    expect(State.view).toBe("dummy-b");
    folded();
  });

  it("the side button does not open or slap: it is no click", () => {
    expect(State.mode).toBe("compact");
    const down = new MouseEvent("mousedown", { button: 3, clientX: 360, clientY: 5, bubbles: true, cancelable: true });
    document.getElementById("island")!.dispatchEvent(down);
    release(3);
    tick(100);
    expect(down.defaultPrevented).toBe(true);
    expect(State.mode).toBe("compact");
  });

  it("travelling sets the side the view comes from", () => {
    open("dummy-a");
    tab("dummy-b");
    release(3);
    expect((document.getElementById("views") as HTMLElement).dataset.nav).toBe("back");
    tab("dummy-b");
    expect((document.getElementById("views") as HTMLElement).dataset.nav).toBeUndefined();
    folded();
  });
});
