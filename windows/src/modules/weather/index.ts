// Clima (Open-Meteo, no key). The forecast is fetched only while the Clima view is on screen (store.ts keeps it ~10 min);
// the status line shows the cached temperature while it is fresh. Nothing runs in the background: no timers, no listeners.
import "./weather.css";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { weatherBridge } from "./bridge";
import { cacheKey, statusText } from "./logic";
import { ICONS } from "./icons";
import { WeatherStore, weatherCfg } from "./store";
import { buildWeatherView } from "./view";

const store = new WeatherStore((lat, lon, units) => weatherBridge.forecast(lat, lon, units));

function start(api: IslandApi): Disposer {
  // Shows the cached temperature only while it belongs to the chosen city and units.
  const showStatus = () => {
    const { place, units } = weatherCfg(api);
    const c = store.cache;
    const f = place && c?.key === cacheKey(place, units) ? c.forecast : null;
    api.status.set(f ? { priority: BAND.AMBIENT, text: statusText(f, units) } : null);
  };
  store.onChange = () => { showStatus(); api.island.redraw(); };
  showStatus();
  return () => {
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
    build: (ctx) => buildWeatherView(ctx, store),
  }],
  tabs: [{ view: "weather", title: "Clima", icon: () => svg(ICONS.cloud, 13), order: 15 }],
  start,
};
