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
import { Compact } from "../../src/core/compact";
import { Pin } from "../../src/core/pin";
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
    expect(State.statusLine).toBeNull();
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

  it("playing with the island visible starts the capture; the compact card shows (no second Mochi), a level reaches the avatar", async () => {
    expect(State.mode).toBe("compact");
    emit("nowplaying-state", track(true));
    await tick(100);
    expect(State.statusLine).toBeNull(); // a source line is shown only when pinned or just after leaving the tab
    Pin.set("nowplaying.track");
    emit("nowplaying-state", track(true, "Faixa")); // same track: the card is republished
    await tick(100);
    expect(captures()).toEqual([true]);
    expect(State.pills.some((p) => p.owner === "nowplaying")).toBe(false); // the one Mochi dances; no ambient mini
    expect(State.statusLine).toMatchObject({ text: "Faixa", card: { sub: "Artista", trail: "-3:19", dim: false, art: null } });
    emit("nowplaying-bands", { bands: Array(16).fill(0.5), level: 0.5 });
    await tick(50); // must not throw
  });

  it("the time left ticks once a second while the compact island shows it; none when hidden or paused", async () => {
    await tick(1000);
    expect(State.statusLine?.card?.trail).toBe("-3:18");
    island.hide();
    await tick(500);
    const frozen = State.statusLine?.card?.trail;
    await tick(5000);
    expect(State.statusLine?.card?.trail).toBe(frozen); // no timer while hidden
    island.reveal();
    await tick(1500);
    expect(State.statusLine?.card?.trail).not.toBe(frozen);
    emit("nowplaying-state", track(false));
    await tick(100);
    const paused = State.statusLine?.card;
    expect(paused?.dim).toBe(true);
    await tick(5000);
    expect(State.statusLine?.card?.trail).toBe(paused?.trail); // paused: nothing runs
    emit("nowplaying-state", { ...track(true), durationMs: null });
    await tick(100);
    expect(State.statusLine?.card?.trail).toBe(""); // unknown length (browsers): no remaining time
    emit("nowplaying-state", track(true));
    await tick(100);
  });

  it("a stronger line (voice, timer, notice) beats the pinned card; it returns when that line goes", async () => {
    Compact.set("claude", { priority: 40, text: "lendo arquivos" });
    expect(State.statusLine?.text).toBe("lendo arquivos");
    expect(State.statusLine?.card).toBeUndefined();
    Compact.set("claude", null);
    expect(State.statusLine?.card?.sub).toBe("Artista");
  });

  it("a pinned line stays beside other pills (overGrid)", () => {
    const own = { owner: "x", label: "l", color: "#fff", mood: "idle" as const };
    const before = State.pills.length;
    State.pills.push({ ...own, id: "t1" }, { ...own, id: "t2", ambient: true });
    expect(State.statusLine?.card?.sub).toBe("Artista"); // t1 is the front pill; t2 is ambient
    State.pills.push({ ...own, id: "t3" });
    expect(State.statusLine?.card?.sub).toBe("Artista"); // the pinned line is not hidden by a second task
    State.pills.length = before;
    State.focusId = State.focusId && State.pills.some((p) => p.id === State.focusId) ? State.focusId : null;
  });

  it("paused or hidden island stops the capture; the same state twice does not repeat the call", async () => {
    const n0 = captures().length;
    emit("nowplaying-state", track(true)); // unchanged
    await tick(100);
    expect(captures().slice(n0)).toEqual([]);
    island.hide();
    await tick(500);
    expect(captures().slice(n0)).toEqual([false]);
    island.reveal();
    await tick(500);
    expect(captures().slice(n0)).toEqual([false, true]);
    emit("nowplaying-state", track(false));
    await tick(100);
    expect(captures().slice(n0)).toEqual([false, true, false]);
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
    emit("settings-changed", {});
    await tick(100);
    expect(captures().at(-1)).toBe(false);
    State.settings.nowplayingDance = true; // switched back on in the settings window: no island event but this one
    emit("settings-changed", {});
    await tick(100);
    expect(captures().at(-1)).toBe(true);
  });

  it("stop releases the capture, the pill, the listeners", async () => {
    emit("nowplaying-state", track(true, "Mais uma"));
    await tick(100);
    expect(captures().at(-1)).toBe(true);
    Registry.apply({ nowplaying: false });
    await tick(100);
    expect(captures().at(-1)).toBe(false);
    expect(State.pills.some((p) => p.owner === "nowplaying")).toBe(false);
    expect(State.statusLine).toBeNull();
    expect(t.handlers.has("nowplaying-state")).toBe(false);
    expect(t.handlers.has("nowplaying-bands")).toBe(false);
    const n = mine().length;
    await tick(10_000);
    expect(mine().length).toBe(n); // nothing keeps running
  });
});

describe("track change card", () => {
  const settle = async () => { await tick(100); };
  const reset = async () => {
    Registry.apply({ nowplaying: false });
    await tick(100);
    Registry.apply({ nowplaying: true });
    await tick(100);
  };
  it("unpinned, hidden: shows the track card for the focus time", async () => {
    await reset();
    Pin.set("");
    island.hide();
    await settle();
    emit("nowplaying-state", track(true, "Nova"));
    await settle();
    expect(State.mode).toBe("compact");
    expect(State.statusLine).toMatchObject({ text: "Nova", card: { sub: "Artista" } });
    await tick(20_000);
    expect(State.statusLine?.text).toBe("Nova");
    emit("nowplaying-state", track(true, "Nova")); // same track: nothing new
    await tick(60_000);
    expect(State.statusLine?.text).not.toBe("Nova");
  });
  it("with a pinned line the card is brief", async () => {
    Pin.set("nowplaying.track");
    island.hide();
    await settle();
    emit("nowplaying-state", track(true, "Outra faixa"));
    await settle();
    const strong = State.statusLine?.priority ?? 0;
    expect(State.statusLine?.text).toBe("Outra faixa");
    await tick(4500);
    expect(State.statusLine?.priority ?? 0).toBeLessThan(strong); // back to the pinned line
  });
  it("expanded: no notice", async () => {
    Pin.set("");
    island.expand("nowplaying");
    await settle();
    emit("nowplaying-state", track(true, "Terceira"));
    await settle();
    expect(State.mode).toBe("expanded");
    expect(State.statusLine?.text).not.toBe("Terceira");
  });
});

describe("player view", () => {
  const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
  const fitted = () => (island as unknown as { views: Map<string, { height?: number }> }).views.get("nowplaying")?.height;
  it("source, title (the app's name without one), controls from can*, play/pause label; one height with or without a length", async () => {
    island.expand("nowplaying");
    emit("nowplaying-state", { ...track(true, ""), canPrev: false });
    await tick(100);
    expect(q(".np-player .np-title").textContent).toBe("Spotify");
    expect(q(".np-src").textContent).toBe("Spotify");
    expect(q<HTMLButtonElement>('.np-btn[aria-label="Faixa anterior"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('.np-btn[aria-label="Próxima faixa"]').disabled).toBe(false);
    expect(q(".np-play").getAttribute("aria-label")).toBe("Pausar");
    expect(q(".np-progress").hidden).toBe(false);
    expect(fitted()).toBe(208);
    emit("nowplaying-state", { ...track(false), durationMs: null, canToggle: false });
    await tick(100);
    expect(q(".np-progress").hidden).toBe(true); // browsers: no length
    expect(q(".np-src").textContent).toBe("Spotify · pausado");
    expect(q(".np-play").getAttribute("aria-label")).toBe("Tocar");
    expect(q<HTMLButtonElement>(".np-play").disabled).toBe(true);
    expect(q(".np-card").classList.contains("np-paused")).toBe(true);
    expect(fitted()).toBe(208);
    emit("nowplaying-state", null);
    await tick(100);
    expect(q(".np-empty").hidden).toBe(false);
    expect(q(".np-player").hidden).toBe(true);
    expect(fitted()).toBe(164);
  });
});
