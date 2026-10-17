// Weather formatting and cache rules: pure (type imports only), so node tests load it directly.
// The numbers come from Open-Meteo already in the chosen units (Rust asks for them).

export type Units = "C" | "F";
export interface Place { name: string; admin: string; country: string; lat: number; lon: number }
/** `windDir` (degrees the wind comes from) and `uv` may be null: the service can leave them out. */
export interface Current { time: string; temp: number; feels: number; humidity: number; wind: number; code: number; isDay: boolean; windDir?: number | null; uv?: number | null }
export interface Hour { time: string; temp: number; code: number; rain: number }
export interface Day { date: string; min: number; max: number; code: number; rain: number }
export interface Forecast { current: Current; hours: Hour[]; days: Day[] }
export interface Cache { key: string; at: number; forecast: Forecast | null; error: string | null }

/** Settings keys of this module (manifest settingsDefaults). */
export interface WeatherCfg { weatherPlace: Place | null; weatherUnits: Units; weatherGlanceEvery?: number }

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

/** The Clima view shows the next 12 hours (one row of columns fitted to the width, never scrolled) and 7 days. */
export const HOURS_SHOWN = 12;
export const DAYS_SHOWN = 7;

/** Which drawn sky a WMO code gets (icons.ts SKY). */
export type Sky = "clear" | "night" | "partly" | "partlyNight" | "cloud" | "fog" | "drizzle" | "rain" | "snow" | "storm";
export function sky(code: number, isDay = true): Sky {
  if (code === 0 || code === 1) return isDay ? "clear" : "night";
  if (code === 2) return isDay ? "partly" : "partlyNight";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "cloud";
}

/** Colour band of a temperature, judged in Celsius whatever the units: cold < 12, cool < 22, warm < 30, hot. */
export type Tone = "cold" | "cool" | "warm" | "hot";
export function tone(v: number, units: Units): Tone {
  const c = units === "F" ? ((v - 32) * 5) / 9 : v;
  return c < 12 ? "cold" : c < 22 ? "cool" : c < 30 ? "warm" : "hot";
}

/** WHO UV bands in pt-BR. */
export function uvLevel(uv: number): { text: string; level: "low" | "mid" | "high" } {
  if (uv < 3) return { text: "baixo", level: "low" };
  if (uv < 6) return { text: "moderado", level: "mid" };
  if (uv < 8) return { text: "alto", level: "high" };
  return { text: uv < 11 ? "muito alto" : "extremo", level: "high" };
}

const POINTS = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
/** Degrees -> one of 8 pt-BR compass points (L = leste, O = oeste). */
export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** The common scale of the 7-day range bars: lowest min and highest max (a 1-degree span at least). */
export function span(days: readonly Pick<Day, "min" | "max">[]): { lo: number; hi: number } {
  const lo = Math.min(...days.map((d) => d.min)), hi = Math.max(...days.map((d) => d.max));
  return days.length ? { lo, hi: Math.max(hi, lo + 1) } : { lo: 0, hi: 1 };
}

// Fixed heights of the view's parts (weather.css), so the island fits its content without measuring. chrome 56 =
// #content padding + header + card border (as eyecare); body padding 12 + 12; head row 22.
const FIT_BASE = 56 + 24 + 22;
const NOTE = 10 + 16, HERO = 10 + 56, TILES = 10 + 54, HOURS = 10 + 72, ROW = 16, ROW_GAP = 6, SEC_HEAD = 10 + 14 + 6;
/** Island height: a one-line note (no city, loading, error), "Agora" (hero, tiles, the hours or a note when there are none),
 *  or "7 dias" (a heading and `days` rows, a note line when 0). Never above 320 (PANEL_H). */
export function fitHeight(tab: "now" | "week" | "note", hours = 0, days = 0): number {
  const need = FIT_BASE + (tab === "note" ? NOTE
    : tab === "now" ? HERO + TILES + (hours ? HOURS : NOTE)
    : SEC_HEAD + (days ? days * ROW + (days - 1) * ROW_GAP : ROW));
  return Math.min(320, need);
}

/** `weatherGlanceEvery` (minutes; 0 or anything invalid = off) -> whole minutes, at most one day. */
export function glanceMinutes(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1440) : 0;
}
