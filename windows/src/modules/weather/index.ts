// Clima (Open-Meteo, no key). The forecast is fetched while the Clima view is on screen (store.ts keeps it ~10 min).
// One-line source "now" (icon + temperature): shown on the compact island when the user pinned it from the Clima tab, or for
// the focus time after leaving the tab. While it is PINNED the forecast is refreshed every 30 min by one api.interval
// (whenVisible: armed only while pinned and the island is visible); the pinned line is also fetched once at start, so a
// hidden island does not release the pin for lack of content. Not pinned: nothing runs in the background.
// weatherGlanceEvery (minutes, 0 = off): one scoped api.timeout, re-armed after each fire, peeks the same line even when the
// island is hidden (fetching first when the cache is older than 30 min).
import "./weather.css";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { weatherBridge } from "./bridge";
import { cacheKey, glanceMinutes, needsPoll, POLL_MS, statusParts, statusText, type WeatherCfg } from "./logic";
import { ICONS } from "./icons";
import { WeatherStore, weatherCfg } from "./store";
import { buildWeatherView } from "./view";

const store = new WeatherStore((lat, lon, units) => weatherBridge.forecast(lat, lon, units));
let showStatus: () => void = () => {};

function start(api: IslandApi): Disposer {
  const source = api.status.source("now", { label: "Clima agora", view: "weather" });
  let poll: Disposer | null = null;
  showStatus = () => {
    const { place, units } = weatherCfg(api);
    const c = store.cache;
    const f = place && c?.key === cacheKey(place, units) ? c.forecast : null;
    // Pinned with no data (offline, failed, no city): a dim placeholder keeps the pin; the 5-min release is for sources that went empty.
    source.set(f ? { priority: BAND.AMBIENT, ...statusParts(f, units) }
      : api.status.pinned("now") ? { priority: BAND.AMBIENT, text: place ? "Clima: sem dados" : "Clima: sem cidade", dim: true } : null);
  };
  /** Fetches when the pinned line has nothing fresh enough. */
  const refresh = () => {
    const { place, units } = weatherCfg(api);
    if (place && needsPoll(store.cache, cacheKey(place, units), Date.now())) store.load(place, units, true);
  };
  const reconcile = () => {
    const on = api.status.pinned("now");
    showStatus(); // the pin may have changed: placeholder or not
    if (on && !poll) {
      poll = api.interval(() => { const { place, units } = weatherCfg(api); if (place) store.load(place, units, true); }, POLL_MS, { whenVisible: true });
      refresh();
    } else if (!on && poll) { poll(); poll = null; }
  };
  let glance: Disposer | null = null;
  let glanceEvery = glanceMinutes(api.settings<WeatherCfg>().weatherGlanceEvery);
  let stopped = false;
  const armGlance = () => {
    glance?.();
    glance = null;
    const min = glanceEvery = glanceMinutes(api.settings<WeatherCfg>().weatherGlanceEvery);
    if (min && weatherCfg(api).place) glance = api.timeout(fireGlance, min * 60_000);
  };
  const fireGlance = async () => {
    glance = null;
    armGlance(); // next one first: a failed fetch still keeps the cadence
    if (api.paused()) return; // Pause: no fetch, no peek; the re-armed one tries again
    const { place, units } = weatherCfg(api);
    if (!place) return;
    const key = cacheKey(place, units);
    if (store.pending === key) return; // a load for this key is already in flight: no second request, the next glance retries
    if (needsPoll(store.cache, key, Date.now())) await store.load(place, units, true);
    const c = store.cache;
    if (stopped || api.paused() || c?.key !== key || !c.forecast || api.island.busy()) return; // failure: skip silently
    api.island.notice({ text: statusText(c.forecast, units), priority: BAND.NOTICE, view: "weather", key: "weather-glance", peek: true, ms: 3000 });
  };
  store.onChange = () => { showStatus(); api.island.redraw(); };
  const offs = [
    api.island.onChange(reconcile),
    // The settings window changed the city or units (the core updates State after its own listener).
    api.listen("settings-changed", () => { api.timeout(() => { showStatus(); reconcile(); if (poll) refresh(); const min = glanceMinutes(api.settings<WeatherCfg>().weatherGlanceEvery); if (min !== glanceEvery || !!glance !== !!(min && weatherCfg(api).place)) armGlance(); }, 0); }),
    // The interval sleeps while hidden: catch up on return.
    api.onVisibility((mode) => { if (mode !== "hidden" && poll) refresh(); }),
  ];
  showStatus();
  reconcile();
  armGlance();
  return () => {
    stopped = true;
    glance?.();
    offs.forEach((o) => o());
    poll?.();
    poll = null;
    showStatus = () => {};
    store.onChange = () => {};
    store.reset();
    source.dispose();
  };
}

export const weatherModule: ModuleDef = {
  id: "weather",
  views: [{
    name: "weather",
    layout: { height: 320, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildWeatherView(ctx, store, () => showStatus()),
  }],
  tabs: [{ view: "weather", title: "Clima", icon: () => svg(ICONS.cloud, 13), order: 45 }],
  start,
};
