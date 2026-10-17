// The module's own glyphs: the tab icon (filled) and the drawn skies of the Clima view (stroked line art on a 24 grid,
// one path per part so weather.css can colour the sun, the cloud and the rain apart). The status line keeps the emoji.
import type { Sky } from "./logic";

export const ICONS = {
  cloud: "M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.9 9.2 4.3 4.3 0 0 1 17.6 18.5H7z",
};

const SUN = "M12 7.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9zM12 2.5v1.5M12 20v1.5M5.3 5.3l1 1M17.7 17.7l1 1M2.5 12H4M20 12h1.5M5.3 18.7l1-1M17.7 6.3l1-1";
const MOON = "M19.5 14.5A8 8 0 1 1 9.5 4.5a6.3 6.3 0 0 0 10 10z";
const SMALL_SUN = "M8.5 5.5a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM8.5 1.8v1.2M3.8 3.8l.8.8M1.8 8.5H3M13.2 3.8l-.8.8";
const SMALL_MOON = "M12.5 8.8A4.6 4.6 0 1 1 6.7 3a3.7 3.7 0 0 0 5.8 5.8z";
/** A cloud low in the box (alone or in front of a small sun/moon, which it hides: weather.css fills it). */
const CLOUD = "M6.5 19h11a3.5 3.5 0 0 0 .4-6.98 5.5 5.5 0 0 0-10.6-1.2A4 4 0 0 0 6.5 19z";
const CLOUD_FRONT = "M9 20.5h9a3 3 0 0 0 .3-5.98 4.6 4.6 0 0 0-8.9-1A3.4 3.4 0 0 0 9 20.5z";
/** The same cloud raised, with room for rain or snow under it. */
const CLOUD_HIGH = "M6.5 15h11a3.5 3.5 0 0 0 .4-6.98 5.5 5.5 0 0 0-10.6-1.2A4 4 0 0 0 6.5 15z";

export type SkyPart = "sun" | "moon" | "cloud" | "front" | "wet" | "snow" | "bolt";
export const SKY: Record<Sky, [SkyPart, string][]> = {
  clear: [["sun", SUN]],
  night: [["moon", MOON]],
  partly: [["sun", SMALL_SUN], ["front", CLOUD_FRONT]],
  partlyNight: [["moon", SMALL_MOON], ["front", CLOUD_FRONT]],
  cloud: [["cloud", CLOUD]],
  fog: [["cloud", "M5 8h12M7 12h13M4 16h13M8 20h9"]],
  drizzle: [["cloud", CLOUD_HIGH], ["wet", "M8.5 18v1M12.5 19v1M16.5 18v1M10.5 21.5v.5M14.5 21.5v.5"]],
  rain: [["cloud", CLOUD_HIGH], ["wet", "M8.5 17.5l-1 3.5M12.5 17.5l-1 3.5M16.5 17.5l-1 3.5"]],
  snow: [["cloud", CLOUD_HIGH], ["snow", "M8 17.5v3.5M6.5 18.4l3 1.7M6.5 20.1l3-1.7M16 17.5v3.5M14.5 18.4l3 1.7M14.5 20.1l3-1.7"]],
  storm: [["cloud", CLOUD_HIGH], ["bolt", "M12.8 15.5l-2.6 3.8h3.6l-2.6 3.7"]],
};
