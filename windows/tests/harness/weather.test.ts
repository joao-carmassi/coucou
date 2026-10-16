// Clima: off = nothing (no status line, no request); on with a city, the forecast is still not fetched while its view is
// not on screen (nothing runs in the background); stop clears the status line and forgets the cache.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { calls } from "./setup";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Compact } from "../../src/core/compact";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { weatherModule } from "../../src/modules/weather";

const manifest = {
  id: "weather", label: "Clima", default: false, order: 15,
  settingsDefaults: { weatherPlace: null, weatherUnits: "C" },
};

beforeAll(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [weatherModule], buildCatalog([manifest], true));
});

beforeEach(() => {
  calls.invoke.length = 0;
});

const weatherCalls = () => calls.invoke.filter((c) => c.cmd.startsWith("weather_"));

describe("weather module", () => {
  it("is off by default: no status line and no request", () => {
    Registry.apply({ weather: false });
    expect(Compact.resolve(0)).toBeNull();
    expect(weatherCalls()).toEqual([]);
  });

  it("on with a city, it still fetches nothing while its view is not on screen", () => {
    (State.settings as unknown as Record<string, unknown>).weatherPlace = { name: "Campinas", admin: "São Paulo", country: "Brasil", lat: -22.9, lon: -47.06 };
    Registry.apply({ weather: true });
    expect(State.mode).not.toBe("expanded"); // the Clima view is the home tab here, but nothing is on screen
    expect(weatherCalls()).toEqual([]);
  });
});
