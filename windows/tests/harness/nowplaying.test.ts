// Tocando agora: nothing runs while it is off; the spectrum capture follows (playing, island visible, dance/view);
// stopping releases it. Driven through the real island with the Tauri bridge faked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const t = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args?: unknown }[],
  handlers: new Map<string, (p: unknown) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    t.invoked.push({ cmd, args });
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    t.handlers.set(name, (payload) => fn({ payload }));
    return () => t.handlers.delete(name);
  },
}));

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { nowplayingModule } from "../../src/modules/nowplaying";
import manifest from "../../src/modules/nowplaying/manifest.json";

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const mine = () => t.invoked.filter((c) => c.cmd.startsWith("nowplaying_"));
const captures = () => mine().filter((c) => c.cmd === "nowplaying_capture").map((c) => (c.args as { on: boolean }).on);
const emit = (name: string, payload: unknown) => t.handlers.get(name)?.(payload);
const track = (playing: boolean, title = "Faixa") => ({
  appId: "Spotify.exe", app: "Spotify", title, artist: "Artista", album: "Álbum", playing,
  canPrev: true, canNext: true, canToggle: true, positionMs: 1000, durationMs: 200_000, at: Date.now(), art: null,
});

let island: Island;
beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [nowplayingModule], buildCatalog([manifest], true));
  island.launch();
  await tick(15_000); // greeting -> compact
});
afterAll(() => vi.useRealTimers());

describe("nowplaying lifecycle", () => {
  it("off: no listener, no command, no pill", async () => {
    Registry.apply({ nowplaying: false });
    await tick(100);
    expect(mine()).toEqual([]);
    expect(t.handlers.has("nowplaying-state")).toBe(false);
    expect(State.pills.some((p) => p.owner === "nowplaying")).toBe(false);
  });

  it("on: asks for the current track once, no capture while nothing plays", async () => {
    Registry.apply({ nowplaying: true });
    await tick(100);
    expect(mine().map((c) => c.cmd)).toEqual(["nowplaying_state"]);
    expect(t.handlers.has("nowplaying-state")).toBe(true);
    emit("nowplaying-state", track(false));
    await tick(100);
    expect(captures()).toEqual([]);
    expect(State.pills.some((p) => p.owner === "nowplaying")).toBe(false);
  });

  it("playing with the island visible starts the capture; a pill and a level reach the avatar", async () => {
    expect(State.mode).toBe("compact");
    emit("nowplaying-state", track(true));
    await tick(100);
    expect(captures()).toEqual([true]);
    expect(State.pills.find((p) => p.owner === "nowplaying")?.label).toBe("Faixa");
    emit("nowplaying-bands", { bands: Array(16).fill(0.5), level: 0.5 });
    await tick(50); // must not throw
  });

  it("paused or hidden island stops the capture; the same state twice does not repeat the call", async () => {
    emit("nowplaying-state", track(true)); // unchanged
    await tick(100);
    expect(captures()).toEqual([true]);
    island.hide();
    await tick(500);
    expect(captures()).toEqual([true, false]);
    island.reveal();
    await tick(500);
    expect(captures()).toEqual([true, false, true]);
    emit("nowplaying-state", track(false));
    await tick(100);
    expect(captures()).toEqual([true, false, true, false]);
    emit("nowplaying-state", track(true));
    await tick(100);
  });

  it("a late bands event after the capture ended is ignored", async () => {
    emit("nowplaying-state", track(false));
    await tick(100);
    emit("nowplaying-bands", { bands: Array(16).fill(1), level: 1 });
    await tick(50);
    expect(captures().at(-1)).toBe(false);
  });

  it("dance off and the view closed: no capture even while playing", async () => {
    State.settings.nowplayingDance = false;
    emit("nowplaying-state", track(true, "Outra"));
    await tick(100);
    expect(captures().at(-1)).toBe(false);
    State.settings.nowplayingDance = true;
    island.hide();
    island.reveal();
    await tick(500);
  });

  it("stop releases the capture, the pill, the listeners", async () => {
    emit("nowplaying-state", track(true, "Mais uma"));
    await tick(100);
    expect(captures().at(-1)).toBe(true);
    Registry.apply({ nowplaying: false });
    await tick(100);
    expect(captures().at(-1)).toBe(false);
    expect(State.pills.some((p) => p.owner === "nowplaying")).toBe(false);
    expect(t.handlers.has("nowplaying-state")).toBe(false);
    expect(t.handlers.has("nowplaying-bands")).toBe(false);
    const n = mine().length;
    await tick(10_000);
    expect(mine().length).toBe(n); // nothing keeps running
  });
});
