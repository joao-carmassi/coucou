// The Clima tab: current conditions, the next 12 hours and 5 days. Nothing here fetches on its own: sync() asks the
// store, and it does nothing unless this view is on screen and the island is expanded.
import { h, clear, replay } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { cacheKey, describe, dayLabel, fmtTemp, hourLabel, placeLabel } from "./logic";
import type { Forecast, Place, Units } from "./logic";
import { weatherCfg } from "./store";
import { pinButton } from "../../kit/pin";
import type { WeatherStore } from "./store";

/** `onSync` runs on every visible sync (the module refreshes its status line there). */
export function buildWeatherView(ctx: ViewContext, store: WeatherStore, onSync: () => void): ViewHost {
  const body = h("div", { class: "stack scroll weather-body" });
  const el = view(card(null, body));
  let shown = "";
  const pin = pinButton(ctx.api, "now");

  const refresh = () => {
    const { place, units } = weatherCfg(ctx.api);
    if (place) store.load(place, units, true);
  };

  const draw = (place: Place | null, units: Units) => {
    clear(body);
    body.append(h("div", { class: "weather-head" },
      h("span", { class: "title", text: place ? placeLabel(place) : "Clima" }),
      h("button", { class: "link-btn text-link", text: "Atualizar", onclick: refresh }), pin.el));
    if (!place) {
      body.append(h("div", { class: "sub", text: "Escolha sua cidade em Configurações › Clima." }));
      return;
    }
    const c = store.cache;
    const fresh = c?.key === cacheKey(place, units) ? c : null;
    if (!fresh?.forecast) {
      body.append(h("div", { class: "sub", text: fresh?.error ? `Não foi possível carregar o clima: ${fresh.error}.` : "Carregando…" }));
      return;
    }
    const f: Forecast = fresh.forecast;
    const now = describe(f.current.code, f.current.isDay);
    // "Hoje" by the city's own date (the forecast's local time), not the machine's clock.
    const today = f.current.time.slice(0, 10);
    body.append(
      h("div", { class: "weather-now" },
        h("span", { class: "weather-icon", text: now.icon }),
        h("div", { class: "weather-main" },
          h("div", { class: "weather-temp", text: fmtTemp(f.current.temp, units) }),
          h("div", { class: "sub", text: now.text })),
        h("div", { class: "weather-detail sub", text: `Sensação ${fmtTemp(f.current.feels, units)} · Umidade ${Math.round(f.current.humidity)}% · Vento ${Math.round(f.current.wind)} km/h` })),
      h("div", { class: "weather-hours" }, ...f.hours.map((x) => h("div", { class: "weather-cell" },
        h("span", { class: "sub", text: hourLabel(x.time) }),
        h("span", { text: describe(x.code).icon }),
        h("span", { text: fmtTemp(x.temp, units) }),
        h("span", { class: "sub", text: `💧${Math.round(x.rain)}%` })))),
      h("div", { class: "weather-days" }, ...f.days.map((d) => h("div", { class: "weather-cell" },
        h("span", { class: "sub", text: dayLabel(d.date, today) }),
        h("span", { text: describe(d.code).icon }),
        h("span", { text: `${Math.round(d.min)}° / ${Math.round(d.max)}°` }),
        h("span", { class: "sub", text: `💧${Math.round(d.rain)}%` })))),
    );
    replay(body, "weather-swap");
  };

  return {
    el,
    sync() {
      // Nothing is fetched or touched while the view is hidden or the island is folded.
      if (ctx.api.island.view() !== "weather" || ctx.api.island.mode() !== "expanded") return;
      onSync();
      pin.sync();
      const { place, units } = weatherCfg(ctx.api);
      if (place) store.load(place, units);
      const c = store.cache;
      const sig = JSON.stringify([place && cacheKey(place, units), c?.key, c?.at, c?.error, store.pending]);
      if (sig !== shown) {
        shown = sig;
        draw(place, units);
      }
    },
  };
}
