// Clima (Open-Meteo, no key). The forecast is fetched only while the Clima view is on screen (store.ts keeps it ~10 min).
// The status line shows the cached temperature while that cache is fresh and belongs to the chosen city and units.
// The settings window can change the city while the island is hidden: the status line is re-checked on every visible
// sync of the view, so until then it can show the old city, for at most the rest of its 10-min ttl (set below).
// Nothing runs in the background: no timers, no listeners.
import "./weather.css";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { weatherBridge } from "./bridge";
import { CACHE_MS, cacheKey, isFresh, statusText } from "./logic";
import { ICONS } from "./icons";
import { WeatherStore, weatherCfg } from "./store";
import { buildWeatherView } from "./view";

const store = new WeatherStore((lat, lon, units) => weatherBridge.forecast(lat, lon, units));
let showStatus: () => void = () => {};

function start(api: IslandApi): Disposer {
  showStatus = () => {
    const { place, units } = weatherCfg(api);
    const now = Date.now();
    const c = store.cache;
    const fresh = place && c?.forecast && c.key === cacheKey(place, units) && isFresh(c, now) ? c : null;
    api.status.set(fresh?.forecast
      ? { priority: BAND.AMBIENT, text: statusText(fresh.forecast, units), ttlMs: CACHE_MS - (now - fresh.at) }
      : null);
  };
  store.onChange = () => { showStatus(); api.island.redraw(); };
  showStatus();
  return () => {
    showStatus = () => {};
    store.onChange = () => {};
    store.reset();
    api.status.set(null);
  };
}

export const weatherModule: ModuleDef = {
  id: "weather",
  views: [{
    name: "weather",
    layout: { height: 240, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildWeatherView(ctx, store, () => showStatus()),
  }],
  tabs: [{ view: "weather", title: "Clima", icon: () => svg(ICONS.cloud, 13), order: 45 }],
  start,
};
