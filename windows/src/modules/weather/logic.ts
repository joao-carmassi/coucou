// Weather formatting and cache rules: pure (type imports only), so node tests load it directly.
// The numbers come from Open-Meteo already in the chosen units (Rust asks for them).

export type Units = "C" | "F";
export interface Place { name: string; admin: string; country: string; lat: number; lon: number }
export interface Current { time: string; temp: number; feels: number; humidity: number; wind: number; code: number; isDay: boolean }
export interface Hour { time: string; temp: number; code: number; rain: number }
export interface Day { date: string; min: number; max: number; code: number; rain: number }
export interface Forecast { current: Current; hours: Hour[]; days: Day[] }
export interface Cache { key: string; at: number; forecast: Forecast | null; error: string | null }

/** Settings keys of this module (manifest settingsDefaults). */
export interface WeatherCfg { weatherPlace: Place | null; weatherUnits: Units }

/** One fetch per city and unit for this long while the view is open; a failure is kept this long too (no retry storm). */
export const CACHE_MS = 10 * 60_000;

/** WMO code (Open-Meteo `weather_code`) -> pt-BR text and an emoji icon. */
export function describe(code: number, isDay = true): { text: string; icon: string } {
  if (code === 0) return { text: "Céu limpo", icon: isDay ? "☀️" : "🌙" };
  if (code === 1) return { text: "Predominantemente limpo", icon: isDay ? "🌤️" : "🌙" };
  if (code === 2) return { text: "Parcialmente nublado", icon: "⛅" };
  if (code === 3) return { text: "Nublado", icon: "☁️" };
  if (code === 45 || code === 48) return { text: "Nevoeiro", icon: "🌫️" };
  if (code >= 51 && code <= 57) return { text: "Garoa", icon: "🌦️" };
  if (code === 66 || code === 67) return { text: "Chuva congelante", icon: "🌧️" };
  if (code >= 61 && code <= 65) return { text: "Chuva", icon: "🌧️" };
  if (code >= 71 && code <= 77) return { text: "Neve", icon: "🌨️" };
  if (code >= 80 && code <= 82) return { text: "Pancadas de chuva", icon: "🌦️" };
  if (code === 85 || code === 86) return { text: "Pancadas de neve", icon: "🌨️" };
  if (code >= 95 && code <= 99) return { text: "Tempestade", icon: "⛈️" };
  return { text: "Tempo indefinido", icon: "❔" };
}

/** "23°C" / "73°F" (rounded). */
export function fmtTemp(v: number, units: Units): string {
  return `${Math.round(v)}°${units}`;
}

/** "2026-10-15T14:00" -> "14h". */
export function hourLabel(iso: string): string {
  return `${iso.slice(11, 13)}h`;
}

const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "2026-10-15" -> "Hoje" when it is `today` (same format), else the short pt-BR weekday. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "Hoje";
  const [y, m, d] = date.split("-").map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}

/** Local calendar day of `ms` as "YYYY-MM-DD" (the format Open-Meteo uses with timezone=auto). */
export function cacheKey(place: Pick<Place, "lat" | "lon">, units: Units): string {
  return `${place.lat},${place.lon},${units}`;
}

export function isFresh(c: Pick<Cache, "at"> | null, now: number): boolean {
  return c !== null && now - c.at >= 0 && now - c.at < CACHE_MS;
}

/** The one-line source while a forecast is cached: icon and "23°C". */
export function statusParts(f: Forecast, units: Units): { icon: string; text: string } {
  return { icon: describe(f.current.code, f.current.isDay).icon, text: fmtTemp(f.current.temp, units) };
}

/** The status text, icon first: "☀️ 23°C". */
export function statusText(f: Forecast, units: Units): string {
  const { icon, text } = statusParts(f, units);
  return `${icon} ${text}`;
}

/** While the line is pinned the forecast is refreshed this often (the island visible). */
export const POLL_MS = 30 * 60_000;

/** The pinned line needs a fetch: nothing cached for this city and units, or the cache is a poll old. */
export function needsPoll(c: Pick<Cache, "key" | "at"> | null, key: string, now: number): boolean {
  return !c || c.key !== key || now - c.at < 0 || now - c.at >= POLL_MS;
}

/** "Cidade, Estado, País" without the empty parts. */
export function placeLabel(p: Place): string {
  return [p.name, p.admin, p.country].filter(Boolean).join(", ");
}
