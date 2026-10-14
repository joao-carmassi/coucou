// The WP0 additions to the module API: pills reads, island.onChange/home/mouse, sound.play and the mochi factories.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe, otherProbe } from "./dummyModule";

const loadModules = async () => {
  const { dummyModule, otherModule } = await import("./dummyModule");
  return { MODULES: [dummyModule, otherModule] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "dummy", label: "Dummy", default: true, order: 1 },
      { id: "other", label: "Other", default: true, order: 2 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Sound } from "../../src/core/sound";
import { State } from "../../src/core/state";
import { miniBotCount, pruneMiniBots, tickMiniBots } from "../../src/mochi/minibots";

const dummy = () => dummyProbe.api!;
const other = () => otherProbe.api!;
const tick = (ms: number) => vi.advanceTimersByTime(ms);

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, other: true });
});
afterAll(() => vi.useRealTimers());

describe("api.pills reads", () => {
  it("front() is State.focusPill, falling back to the first pill", () => {
    expect(dummy().pills.front()).toBe(State.focusPill);
    expect(dummy().pills.front()!.id).toBe("dummy-pill");
    State.focusId = "nobody";
    expect(dummy().pills.front()!.id).toBe("dummy-pill"); // fallback: first pill
    State.focusId = "dummy-pill";
  });

  it("all / get / others keep the order and leave the front out of others", () => {
    expect(dummy().pills.all().map((p) => p.id)).toEqual(["dummy-pill", "other-pill"]);
    expect(dummy().pills.get("other-pill")!.owner).toBe("other");
    expect(dummy().pills.get("nope")).toBeNull();
    expect(dummy().pills.others().map((p) => p.id)).toEqual(["other-pill"]);
  });
});

describe("api.island reads", () => {
  it("mouse / mouseLocal read State live", () => {
    State.mouse = { x: 7, y: 9 };
    State.mouseInIsland = { x: 1, y: 2 };
    expect(dummy().island.mouse()).toEqual({ x: 7, y: 9 });
    expect(dummy().island.mouseLocal()).toEqual({ x: 1, y: 2 });
  });
});

describe("mochi + sound", () => {
  it("sound.play reaches the engine", () => {
    const spy = vi.spyOn(Sound, "play").mockImplementation(() => {});
    dummy().sound.play("pop");
    expect(spy).toHaveBeenCalledWith("pop");
    spy.mockRestore();
  });

  it("mini and free canvases tick, and are pruned once detached", () => {
    dummy().island.wake(); // hidden is lazy (no frames); compact draws its own mini grid, so count after that settles
    tick(100);
    const before = miniBotCount();
    const mini = dummy().mochi.mini(dummy().pills.get("dummy-pill")!, 20);
    const free = dummy().mochi.free("#22C55E", "done", 20, 0.8);
    document.body.append(mini, free.el);
    expect(miniBotCount()).toBe(before + 2);

    const get = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    tickMiniBots(0.016);
    const ticked = get.mock.contexts.filter((c) => c === mini.querySelector("canvas") || c === free.el.querySelector("canvas"));
    expect(ticked).toHaveLength(2);
    get.mockRestore();

    mini.remove();
    free.el.remove();
    State.notify();
    State.notify();
    tick(100); // a frame: the island syncs and prunes
    expect(miniBotCount()).toBe(before);
  });

  it("free.set puts the canvas back among the live ones", () => {
    const before = miniBotCount();
    const free = dummy().mochi.free("#3B9EFF", "working", 20);
    document.body.append(free.el);
    free.el.remove();
    pruneMiniBots();
    expect(miniBotCount()).toBe(before); // dropped
    document.body.append(free.el);
    free.set("#F4505E", "error");
    expect(miniBotCount()).toBe(before + 1);
    free.el.remove();
    pruneMiniBots();
  });

  it("sprite wraps an engine: state, emote (ms) and colour do not throw, draw reaches the context", () => {
    const sprite = dummy().mochi.sprite({ overhang: 40 });
    const ctx = document.createElement("canvas").getContext("2d")!;
    sprite.setState("working", true);
    sprite.emote("surprised", 60_000);
    sprite.color("#88aaff");
    sprite.color(null);
    sprite.update(0.016);
    expect(() => sprite.draw(ctx, 84, 124)).not.toThrow();
  });
});

describe("island.onChange and home", () => {
  it("fires on pills.set and stops when the module stops", () => {
    const api = dummy();
    let n = 0;
    api.island.onChange(() => n++);
    other().pills.set({ id: "other-pill", label: "Other 2", color: "#ffaa88" });
    expect(n).toBe(1);
    Registry.apply({ dummy: false, other: true });
    other().pills.set({ id: "other-pill", label: "Other 3", color: "#ffaa88" });
    expect(n).toBe(1);
  });

  it("home() is 'empty' with no modules, live", () => {
    Registry.apply({ dummy: true, other: true });
    const api = dummy();
    expect(api.island.home()).toBe("dummy-a"); // first tab
    Registry.apply({ dummy: false, other: false });
    expect(api.island.home()).toBe("empty");
  });
});
