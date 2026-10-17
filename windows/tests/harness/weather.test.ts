// Clima: off = nothing; on with a city, nothing is fetched while the Clima view is not on screen; when it is, exactly one
// forecast request and a cache hit on the next sync; stop drops the status line.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Compact } from "../../src/core/compact";
import { State } from "../../src/core/state";
import { Pin } from "../../src/core/pin";
import { buildCatalog } from "../../src/modules/resolve";

// Counted fake for the Rust bridge: no network in the harness.
const T = vi.hoisted(() => ({ forecasts: 0, host: null as null | { sync(): void }, island: null as null | Island }));
vi.mock("../../src/modules/weather/bridge", () => ({
  weatherBridge: {
    forecast: async () => {
      T.forecasts++;
      return {
        current: { time: "2026-10-15T14:20", temp: 22.6, feels: 21, humidity: 50, wind: 10, code: 2, isDay: true },
        hours: [], days: [],
      };
    },
    search: async () => [],
  },
}));

const { weatherModule: base } = await import("../../src/modules/weather");
// Capture the view host the core builds, the way markup.test.ts does.
const weatherModule = {
  ...base,
  views: base.views?.map((v) => ({ ...v, build: (ctx: any) => (T.host = v.build(ctx)) })),
};

const manifest = {
  id: "weather", label: "Clima", default: false, order: 15,
  settingsDefaults: { weatherPlace: null, weatherUnits: "C" },
};
const place = { name: "Campinas", admin: "São Paulo", country: "Brasil", lat: -22.9, lon: -47.06 };
const settings = () => State.settings as unknown as Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  document.body.innerHTML = '<div id="root"></div>';
  T.island = new Island(document.getElementById("root")!);
  Registry.init(T.island, [weatherModule], buildCatalog([manifest], true));
});

afterAll(() => Registry.apply({ weather: false }));

beforeEach(() => {
  Registry.apply({ weather: false });
  T.forecasts = 0;
  T.host = null;
  settings().weatherPlace = place;
  State.settings.pinnedLine = "";
});

describe("weather module", () => {
  it("is off by default: no status line and no request", () => {
    settings().weatherPlace = null;
    Registry.apply({ weather: false });
    expect(Compact.resolve(0)).toBeNull();
    expect(T.forecasts).toBe(0);
  });

  it("on with a city, nothing is fetched while its view is not on screen", () => {
    Registry.apply({ weather: true });
    expect(State.mode).not.toBe("expanded");
    expect(T.forecasts).toBe(0);
  });

  it("opening the view fetches exactly once; the next sync is a cache hit", async () => {
    Registry.apply({ weather: true });
    T.island!.open("weather");
    expect(State.view).toBe("weather");
    expect(State.mode).toBe("expanded");
    T.host!.sync();
    T.host!.sync();
    await tick();
    expect(T.forecasts).toBe(1);
    T.host!.sync();
    await tick();
    expect(T.forecasts).toBe(1);
  });

  it("stop drops the status line after a cached forecast", async () => {
    Registry.apply({ weather: true });
    T.island!.open("weather");
    T.host!.sync();
    await tick();
    expect(Compact.resolve(0)).toBeNull(); // not pinned, not left yet: no line
    Pin.set("weather.now");
    expect(Compact.resolve(0)?.text).toMatch(/23°C/);
    expect(Compact.resolve(0)?.icon).toBe("⛅");
    Registry.apply({ weather: false });
    expect(Compact.resolve(0)).toBeNull();
  });

  it("pinned: one 30-min interval, armed only while the island is visible; hidden = none", async () => {
    vi.useFakeTimers();
    const live = new Set<unknown>();
    const armed: { fn: () => void; ms: number }[] = [];
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = ((fn: () => void, ms: number) => { const id = si(fn, ms); live.add(id); armed.push({ fn, ms }); return id; }) as typeof window.setInterval;
    window.clearInterval = ((id: number) => { live.delete(id); ci(id); }) as typeof window.clearInterval;
    try {
      State.settings.pinnedLine = "weather.now";
      Registry.apply({ weather: true });
      await vi.advanceTimersByTimeAsync(50);
      const fetched = T.forecasts; // once at start, even if hidden
      expect(fetched).toBe(1);
      T.island!.hide();
      await vi.advanceTimersByTimeAsync(100);
      expect(live.size).toBe(0); // hidden: no interval armed
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(T.forecasts).toBe(fetched); // hidden: no polling at all
      State.settings.compactHideInterval = 0; // never hides again on its own
      T.island!.applySettings();
      T.island!.reveal();
      await vi.advanceTimersByTimeAsync(100);
      expect(live.size).toBe(1); // pinned and visible: exactly the one poll
      expect(T.forecasts).toBe(fetched + 1); // caught up on return (cache older than 30 min)
      const poll = armed.at(-1)!;
      expect(poll.ms).toBe(30 * 60_000);
      poll.fn(); // the interval fires
      await vi.advanceTimersByTimeAsync(10);
      expect(T.forecasts).toBe(fetched + 2);
      Pin.set("");
      await vi.advanceTimersByTimeAsync(100);
      expect(live.size).toBe(0);
    } finally {
      State.settings.compactHideInterval = 60;
      window.setInterval = si;
      window.clearInterval = ci;
      vi.useRealTimers();
    }
  });

  it("not pinned: no polling, no timers of its own", async () => {
    Registry.apply({ weather: true });
    expect(T.forecasts).toBe(0);
  });

  it("the Clima view's pin button toggles the pin and shows it", async () => {
    Registry.apply({ weather: true });
    T.island!.open("weather");
    T.host!.sync();
    await tick();
    T.host!.sync();
    const btn = document.querySelector<HTMLButtonElement>(".weather-head .pin-btn")!;
    expect(btn.title).toBe("Fixar na ilha");
    btn.click();
    expect(State.settings.pinnedLine).toBe("weather.now");
    expect(btn.title).toBe("Soltar");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.click();
    expect(State.settings.pinnedLine).toBe("");
    expect(btn.title).toBe("Fixar na ilha");
  });

  it("module off: the source is gone and the pin stays in the settings", async () => {
    State.settings.pinnedLine = "weather.now";
    Registry.apply({ weather: true });
    T.island!.open("weather");
    T.host!.sync();
    await tick();
    expect(Compact.resolve(0)?.text).toMatch(/23°C/);
    Registry.apply({ weather: false });
    expect(Compact.resolve(0)).toBeNull();
    expect(State.settings.pinnedLine).toBe("weather.now");
  });

  it("pinned with no city: a dim placeholder keeps the pin past the 5-minute release", async () => {
    vi.useFakeTimers();
    try {
      settings().weatherPlace = null;
      State.settings.pinnedLine = "weather.now";
      Registry.apply({ weather: true });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(State.settings.pinnedLine).toBe("weather.now");
      expect(Compact.resolve(0)).toMatchObject({ text: "Clima: sem cidade", dim: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
