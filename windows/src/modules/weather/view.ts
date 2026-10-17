// The Clima tab, two tabs: "Agora" (big temperature, condition, four tiles, the next 12 hours fitted to the width) and
// "7 dias" (one row per day, min-max bars on a common scale). Nothing here fetches on its own: sync() asks the store, and
// it does nothing unless this view is on screen and the island is expanded. Heights are fixed (logic.ts fitHeight adds
// them up), nothing animates.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import {
  cacheKey, compass, DAYS_SHOWN, describe, dayLabel, fitHeight, HOURS_SHOWN, hourLabel, placeLabel, sky, span, tone, uvLevel,
  type Forecast, type Place, type Sky, type Units,
} from "./logic";
import { SKY } from "./icons";
import { weatherCfg } from "./store";
import { pinButton } from "../../kit/pin";
import type { WeatherStore } from "./store";

type Tab = "now" | "week";
const NS = "http://www.w3.org/2000/svg";
const deg = (v: number) => `${Math.round(v)}°`;
const pct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const clock = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** A drawn sky: one stroked path per part, coloured by weather.css. */
function skyIcon(s: Sky, size: number, label?: string): SVGSVGElement {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("class", "weather-sky");
  if (label) { el.setAttribute("role", "img"); el.setAttribute("aria-label", label); } else el.setAttribute("aria-hidden", "true");
  for (const [part, d] of SKY[s]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("class", part);
    el.append(p);
  }
  return el;
}
function bar(fill: number, cls: string) {
  const i = h("i");
  i.style.width = `${fill > 0 ? Math.max(3, fill) : 0}%`;
  return h("span", { class: `weather-bar ${cls}` }, i);
}
function tile(k: string, v: string, foot: string | HTMLElement) {
  return h("div", { class: "weather-tile" }, h("span", { class: "weather-k", text: k }), h("b", { class: "weather-v", text: v }),
    typeof foot === "string" ? h("span", { class: "weather-foot", text: foot }) : foot);
}
const note = (text: string) => h("div", { class: "weather-note", text, title: text });

/** "Agora": hero, tiles, then the hours (or a note when the service sent none). */
function nowPanel(f: Forecast, units: Units): HTMLElement[] {
  const c = f.current, d = describe(c.code, c.isDay), today = f.days[0];
  const hours = f.hours.slice(0, HOURS_SHOWN);
  // Rain: the likeliest of the next hours (today's chance when the service sent no hours).
  const wet = hours.length ? hours.reduce((a, x) => (x.rain > a.rain ? x : a)) : { rain: today?.rain ?? 0, time: "" };
  const uv = c.uv == null ? null : uvLevel(c.uv);
  return [
    h("div", { class: "weather-hero" },
      skyIcon(sky(c.code, c.isDay), 44, d.text),
      h("div", { class: `weather-temp ${tone(c.temp, units)}` }, deg(c.temp), h("span", { class: "weather-unit", text: units })),
      h("div", { class: "weather-cond" },
        h("span", { class: "weather-cond-text", text: d.text }),
        h("span", { class: "weather-foot", text: [`Sensação ${deg(c.feels)}`, today && `mín ${deg(today.min)} · máx ${deg(today.max)}`].filter(Boolean).join(" · ") }))),
    h("div", { class: "weather-tiles" },
      tile("Vento", `${Math.round(c.wind)} km/h`, c.windDir == null ? "a 10 m do chão" : `vindo de ${compass(c.windDir)}`),
      tile("Umidade", `${pct(c.humidity)}%`, bar(pct(c.humidity), "damp")),
      tile("Chuva", `${pct(wet.rain)}%`, wet.rain < 1 ? "sem chuva prevista" : wet.time ? `maior chance às ${hourLabel(wet.time)}` : "chance hoje"),
      tile("Índice UV", uv ? String(Math.round(c.uv as number)) : "–", uv ? h("span", { class: `weather-foot uv-${uv.level}`, text: uv.text }) : "sem dado")),
    hours.length
      ? h("div", { class: "weather-hours", role: "list", "aria-label": "Próximas horas" }, ...hours.map((x, i) => {
        const p = pct(x.rain);
        return h("div", { class: "weather-hour", role: "listitem", title: `${hourLabel(x.time)} · ${describe(x.code).text} · ${deg(x.temp)} · chuva ${p}%` },
          h("span", { class: "weather-hour-at", text: i ? hourLabel(x.time) : "Agora" }),
          skyIcon(sky(x.code), 18),
          h("span", { class: "weather-hour-temp", text: deg(x.temp) }),
          h("span", { class: p < 20 ? "weather-hour-rain dry" : "weather-hour-rain", text: `${p}%` }),
          bar(p, "rain"));
      }))
      : note("Sem previsão por hora."),
  ];
}

/** "7 dias": a heading and one row per day; the bar spans min-max on the week's own scale, today marks the temperature now. */
function weekPanel(f: Forecast, units: Units): HTMLElement[] {
  const days = f.days.slice(0, DAYS_SHOWN);
  const today = f.current.time.slice(0, 10); // the city's own date (the forecast's local time), not the machine's clock
  const { lo, hi } = span(days);
  const at = (v: number) => Math.round(((v - lo) / (hi - lo)) * 1000) / 10;
  return [h("div", { class: "weather-sec" },
    h("div", { class: "weather-sec-head" }, h("span", { class: "weather-k", text: `Próximos ${days.length || DAYS_SHOWN} dias` }), h("span", { class: "weather-foot", text: "chuva · mín – máx" })),
    days.length ? h("div", { class: "weather-days", role: "list" }, ...days.map((d) => {
      const fill = h("i", { class: "weather-range-fill" });
      fill.style.left = `${at(d.min)}%`;
      fill.style.width = `${Math.max(2, Math.round((at(d.max) - at(d.min)) * 10) / 10)}%`;
      fill.style.background = `linear-gradient(90deg, var(--weather-${tone(d.min, units)}), var(--weather-${tone(d.max, units)}))`;
      const range = h("span", { class: "weather-range" }, fill);
      if (d.date === today) {
        const dot = h("i", { class: "weather-range-now", title: `Agora: ${deg(f.current.temp)}` });
        dot.style.left = `${at(Math.max(lo, Math.min(hi, f.current.temp)))}%`;
        range.append(dot);
      }
      const p = pct(d.rain), label = dayLabel(d.date, today);
      return h("div", { class: d.date === today ? "weather-day today" : "weather-day", role: "listitem", title: `${label} · ${describe(d.code).text}` },
        h("span", { class: "weather-day-name", text: label }),
        skyIcon(sky(d.code), 16),
        h("span", { class: p < 20 ? "weather-day-rain dry" : "weather-day-rain", text: `${p}%` }),
        h("span", { class: "weather-day-min", text: deg(d.min) }),
        range,
        h("span", { class: "weather-day-max", text: deg(d.max) }));
    })) : note("Sem previsão para os próximos dias."))];
}

/** `onSync` runs on every visible sync (the module refreshes its status line there). */
export function buildWeatherView(ctx: ViewContext, store: WeatherStore, onSync: () => void): ViewHost {
  let tab: Tab = "now";
  let shown = "";
  let fitted = fitHeight("note");
  const title = h("span", { class: "weather-title", text: "Clima" });
  const when = h("span", { class: "weather-foot" });
  const again = h("button", { type: "button", class: "link-btn text-link", text: "Atualizar" });
  const tabBtn = (t: Tab, text: string) => h("button", { type: "button", role: "tab", text, onclick: () => { tab = t; update(); } });
  const tabs: Record<Tab, HTMLButtonElement> = { now: tabBtn("now", "Agora"), week: tabBtn("week", "7 dias") };
  const seg = h("div", { class: "seg weather-tabs", role: "tablist", "aria-label": "Período" }, tabs.now, tabs.week);
  const head = h("div", { class: "weather-head pin-room" }, title, when, h("span", { class: "grow" }), again, seg);
  const panel = h("div", { class: "weather-panel", role: "tabpanel" });
  const body = h("div", { class: "stack scroll weather-body" }, head, panel);
  const pin = pinButton(ctx.api, "now");
  const el = view(card(null, body, pin.el)); // pin: sibling of the scrolling body, inside the positioned card

  const draw = (place: Place | null, units: Units) => {
    const c = store.cache;
    const mine = place && c?.key === cacheKey(place, units) ? c : null;
    const f = mine?.forecast ?? null;
    const busy = !!place && store.pending === cacheKey(place, units);
    title.textContent = place?.name || "Clima";
    if (place) title.title = placeLabel(place); else title.removeAttribute("title");
    when.textContent = busy && f ? "atualizando…" : mine && f ? `às ${clock(mine.at)}` : "";
    again.hidden = !place;
    again.disabled = busy;
    seg.hidden = !f;
    for (const t of Object.keys(tabs) as Tab[]) {
      tabs[t].classList.toggle("on", t === tab);
      tabs[t].setAttribute("aria-selected", String(t === tab));
    }
    clear(panel);
    let fit: number;
    if (!place) { panel.append(note("Escolha sua cidade em Configurações › Clima.")); fit = fitHeight("note"); }
    else if (!f) { panel.append(note(mine?.error ? `Não foi possível carregar o clima: ${mine.error}.` : "Carregando a previsão…")); fit = fitHeight("note"); }
    else if (tab === "now") { panel.append(...nowPanel(f, units)); fit = fitHeight("now", Math.min(HOURS_SHOWN, f.hours.length)); }
    else { panel.append(...weekPanel(f, units)); fit = fitHeight("week", 0, Math.min(DAYS_SHOWN, f.days.length)); }
    if (fit !== fitted) { fitted = fit; ctx.onResize(); }
  };
  /** Asks the store (a cache hit costs nothing) and redraws when something it shows changed. */
  const update = () => {
    const { place, units } = weatherCfg(ctx.api);
    if (place) store.load(place, units);
    const c = store.cache;
    const sig = JSON.stringify([place, units, c?.key, c?.at, c?.error, store.pending, tab]);
    if (sig !== shown) {
      shown = sig;
      draw(place, units);
    }
  };
  again.addEventListener("click", () => {
    const { place, units } = weatherCfg(ctx.api);
    if (place) void store.load(place, units, true);
    update();
  });

  return {
    el,
    get height() { return fitted; },
    sync() {
      // Nothing is fetched or touched while the view is hidden or the island is folded.
      if (ctx.api.island.view() !== "weather" || ctx.api.island.mode() !== "expanded") return;
      onSync();
      pin.sync();
      update();
    },
  };
}
