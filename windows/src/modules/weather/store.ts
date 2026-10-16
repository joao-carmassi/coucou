// The module's one forecast cache (in memory, about 10 min). It fetches only when asked: the view calls load() while it
// is on screen, and nothing else does. A reply that a newer request superseded (another city, a refresh) is dropped.
import { cacheKey, isFresh } from "./logic";
import type { Cache, Forecast, Place, Units, WeatherCfg } from "./logic";

export class WeatherStore {
  cache: Cache | null = null;
  pending: string | null = null;
  /** Set by the module: a reply landed. */
  onChange: () => void = () => {};
  private seq = 0;

  constructor(private readonly source: (lat: number, lon: number, units: Units) => Promise<Forecast | null>) {}

  load(place: Place, units: Units, force = false, now = Date.now()): void {
    const key = cacheKey(place, units);
    if (!force && (this.pending === key || (this.cache?.key === key && isFresh(this.cache, now)))) return;
    const seq = ++this.seq;
    this.pending = key;
    this.source(place.lat, place.lon, units).then(
      (forecast) => (forecast ? { forecast, error: null } : { forecast: null, error: "sem dados do serviço de clima" }),
      (err) => ({ forecast: null, error: err instanceof Error ? err.message : String(err) }),
    ).then((r) => {
      if (seq !== this.seq) return;
      this.cache = { key, at: Date.now(), ...r };
      this.pending = null;
      this.onChange();
    });
  }

  /** Drops the cache and ignores any reply still on the way (the module stopped). */
  reset(): void {
    this.cache = null;
    this.pending = null;
    this.seq++;
  }
}

/** The module's settings as the view and the module read them. */
export function weatherCfg(api: { settings<T extends object>(): Readonly<T> }): { place: Place | null; units: Units } {
  const c = api.settings<WeatherCfg>();
  return { place: c.weatherPlace ?? null, units: c.weatherUnits === "F" ? "F" : "C" };
}
