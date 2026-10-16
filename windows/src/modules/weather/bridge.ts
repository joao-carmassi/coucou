import { commandOrThrow } from "../../kit/tauri";
import type { Forecast, Place, Units } from "./logic";

export const weatherBridge = {
  forecast: (lat: number, lon: number, units: Units) => commandOrThrow<Forecast>("weather_forecast", { lat, lon, units }),
  search: (query: string) => commandOrThrow<Place[]>("weather_search", { query }),
};
