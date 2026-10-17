import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_MS, cacheKey, describe, dayLabel, fmtTemp, hourLabel, isFresh, needsPoll, placeLabel, POLL_MS, statusParts, statusText, glanceMinutes } from "../src/modules/weather/logic.ts";
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

test("the strips never scroll: no overflow-x/auto/scroll rule on them, pin is a direct child of a relative body", () => {
  const css = readFileSync(new URL("../src/modules/weather/weather.css", import.meta.url), "utf8");
  const strips = css.split("\n").filter((l) => /\.weather-(hours|days)/.test(l)).join("\n");
  assert.doesNotMatch(strips, /overflow(-x|-y)?:\s*(auto|scroll)/);
  assert.match(css, /\.weather-body\s*\{[^}]*position:\s*relative[^}]*padding:\s*14px 48px/);
  const view = readFileSync(new URL("../src/modules/weather/view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(view, /weather-head"[^]*?pin\.el\)\)/);
});
