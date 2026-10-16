// Clima: off = nothing; on with a city, nothing is fetched while the Clima view is not on screen; when it is, exactly one
// forecast request and a cache hit on the next sync; stop drops the status line.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Compact } from "../../src/core/compact";
import { State } from "../../src/core/state";
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
    expect(Compact.resolve(0)?.text).toMatch(/23°C/);
    Registry.apply({ weather: false });
    expect(Compact.resolve(0)).toBeNull();
  });
});
