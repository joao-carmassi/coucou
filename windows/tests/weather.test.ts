import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_MS, cacheKey, describe, dayLabel, fmtTemp, hourLabel, isFresh, needsPoll, placeLabel, POLL_MS, statusParts, statusText, glanceMinutes, sky, tone, uvLevel, compass, span, fitHeight, HOURS_SHOWN, DAYS_SHOWN } from "../src/modules/weather/logic.ts";
import { readFileSync } from "node:fs";
import type { Forecast } from "../src/modules/weather/logic.ts";

test("WMO codes map to pt-BR text and an icon, day and night", () => {
  assert.deepEqual(describe(0, true), { text: "Céu limpo", icon: "☀️" });
  assert.deepEqual(describe(0, false), { text: "Céu limpo", icon: "🌙" });
  assert.equal(describe(3).text, "Nublado");
  assert.equal(describe(45).text, "Nevoeiro");
  assert.equal(describe(48).text, "Nevoeiro");
  assert.equal(describe(63).text, "Chuva");
  assert.equal(describe(67).text, "Chuva congelante");
  assert.equal(describe(75).text, "Neve");
  assert.equal(describe(82).text, "Pancadas de chuva");
  assert.equal(describe(86).text, "Pancadas de neve");
  assert.equal(describe(96).text, "Tempestade");
  assert.equal(describe(99).text, "Tempestade");
});

test("unknown WMO codes fall back instead of throwing", () => {
  for (const code of [4, 30, 58, 100, -1]) assert.equal(describe(code).text, "Tempo indefinido");
});

test("temperatures are rounded and carry the unit", () => {
  assert.equal(fmtTemp(21.4, "C"), "21°C");
  assert.equal(fmtTemp(21.5, "C"), "22°C");
  assert.equal(fmtTemp(-3.6, "C"), "-4°C");
  assert.equal(fmtTemp(70.2, "F"), "70°F");
});

test("hour label is the hour of the local ISO time", () => {
  assert.equal(hourLabel("2026-10-15T14:00"), "14h");
  assert.equal(hourLabel("2026-10-15T00:00"), "00h");
});

test("day label: Hoje for today, else a short weekday", () => {
  assert.equal(dayLabel("2026-10-15", "2026-10-15"), "Hoje");
  // 2026-10-16 is a Friday.
  assert.equal(dayLabel("2026-10-16", "2026-10-15"), "sex");
  assert.equal(dayLabel("2026-10-17", "2026-10-15"), "sáb");
});

test("cache is fresh for CACHE_MS and never for a future or missing entry", () => {
  const at = 1_000_000;
  assert.equal(isFresh({ at }, at), true);
  assert.equal(isFresh({ at }, at + CACHE_MS - 1), true);
  assert.equal(isFresh({ at }, at + CACHE_MS), false);
  assert.equal(isFresh(null, at), false);
  assert.equal(isFresh({ at }, at - 5), false);
});

test("cache key depends on the coordinates and the units", () => {
  const p = { lat: -23.5, lon: -46.6 };
  assert.notEqual(cacheKey(p, "C"), cacheKey(p, "F"));
  assert.notEqual(cacheKey(p, "C"), cacheKey({ lat: -22.9, lon: -46.6 }, "C"));
  assert.equal(cacheKey(p, "C"), "-23.5,-46.6,C");
});

test("status text is the icon and the temperature of the current conditions", () => {
  const f = { current: { time: "", temp: 22.6, feels: 20, humidity: 50, wind: 10, code: 2, isDay: true }, hours: [], days: [] } as Forecast;
  assert.equal(statusText(f, "C"), "⛅ 23°C");
  assert.equal(statusText(f, "F"), "⛅ 23°F");
});

test("place label drops empty parts", () => {
  assert.equal(placeLabel({ name: "Campinas", admin: "São Paulo", country: "Brasil", lat: 0, lon: 0 }), "Campinas, São Paulo, Brasil");
  assert.equal(placeLabel({ name: "Ilha", admin: "", country: "", lat: 0, lon: 0 }), "Ilha");
});

test("status parts split the icon from the temperature; the pinned line polls every 30 min", () => {
  const f = { current: { time: "", temp: 22.6, feels: 20, humidity: 50, wind: 10, code: 2, isDay: true }, hours: [], days: [] } as Forecast;
  assert.deepEqual(statusParts(f, "C"), { icon: "⛅", text: "23°C" });
  assert.equal(POLL_MS, 1_800_000);
  assert.equal(needsPoll(null, "k", 10), true);
  assert.equal(needsPoll({ key: "other", at: 0 }, "k", 10), true);
  assert.equal(needsPoll({ key: "k", at: 0 }, "k", POLL_MS - 1), false);
  assert.equal(needsPoll({ key: "k", at: 0 }, "k", POLL_MS), true);
});

test("glanceMinutes: 0 and junk are off, whole minutes, capped at a day", () => {
  for (const v of [0, -5, NaN, undefined, null, "x"]) assert.equal(glanceMinutes(v), 0);
  assert.equal(glanceMinutes(30), 30);
  assert.equal(glanceMinutes(15.9), 15);
  assert.equal(glanceMinutes(99999), 1440);
});

test("the strips never scroll: no overflow-x/auto/scroll rule on them; the pin sits on the card, the head keeps room for it", () => {
  const css = readFileSync(new URL("../src/modules/weather/weather.css", import.meta.url), "utf8");
  const strips = css.split("\n").filter((l) => /\.weather-(hours|hour|days|day)\b/.test(l)).join("\n");
  assert.doesNotMatch(strips, /overflow(-x|-y)?:\s*(auto|scroll)/);
  assert.doesNotMatch(css, /animation|@keyframes|transition/); // no shimmer or slide-in on text
  const view = readFileSync(new URL("../src/modules/weather/view.ts", import.meta.url), "utf8");
  assert.match(view, /card\(null, body, pin\.el\)/);
  assert.match(view, /weather-head pin-room/);
});

test("drawn skies: WMO codes to a sky, day and night", () => {
  assert.equal(sky(0), "clear");
  assert.equal(sky(1, false), "night");
  assert.equal(sky(2), "partly");
  assert.equal(sky(2, false), "partlyNight");
  assert.equal(sky(3), "cloud");
  assert.equal(sky(48), "fog");
  assert.equal(sky(53), "drizzle");
  assert.equal(sky(65), "rain");
  assert.equal(sky(81), "rain");
  assert.equal(sky(86), "snow");
  assert.equal(sky(95), "storm");
  assert.equal(sky(100), "cloud"); // unknown: a plain cloud, never a throw
});

test("temperature tone is judged in Celsius in both units", () => {
  assert.equal(tone(5, "C"), "cold");
  assert.equal(tone(18, "C"), "cool");
  assert.equal(tone(27, "C"), "warm");
  assert.equal(tone(33, "C"), "hot");
  assert.equal(tone(41, "F"), "cold"); // 5 °C
  assert.equal(tone(91, "F"), "hot"); // ~33 °C
});

test("UV bands, compass points and the week scale", () => {
  assert.deepEqual(uvLevel(1), { text: "baixo", level: "low" });
  assert.equal(uvLevel(4).text, "moderado");
  assert.equal(uvLevel(7).level, "high");
  assert.equal(uvLevel(9).text, "muito alto");
  assert.equal(uvLevel(12).text, "extremo");
  assert.equal(compass(0), "N");
  assert.equal(compass(90), "L");
  assert.equal(compass(225), "SO");
  assert.equal(compass(350), "N");
  assert.equal(compass(-90), "O");
  assert.deepEqual(span([{ min: 13, max: 24 }, { min: 11, max: 19 }]), { lo: 11, hi: 24 });
  assert.deepEqual(span([{ min: 20, max: 20 }]), { lo: 20, hi: 21 }); // never a zero span
  assert.deepEqual(span([]), { lo: 0, hi: 1 });
});

test("the island fits the Clima content: no dead space, never past 320", () => {
  assert.equal(HOURS_SHOWN, 12);
  assert.equal(DAYS_SHOWN, 7);
  assert.equal(fitHeight("note"), 128);
  assert.equal(fitHeight("now", 12), 314);
  assert.equal(fitHeight("now", 0), 258);
  assert.equal(fitHeight("week", 0, 7), 280);
  assert.equal(fitHeight("week", 0, 0), 148);
  for (const n of [0, 5, 7, 30]) assert.ok(fitHeight("week", 0, n) <= 320);
});
