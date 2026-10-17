import { test } from "node:test";
import assert from "node:assert/strict";
import { compactCard, remaining, wantTick, clampSens, clock, danceLevel, fraction, positionAt, shapeBands, trackKey, trackLine, wantCapture, type Track } from "../src/modules/nowplaying/logic.ts";

const T = (o: Partial<Track> = {}): Track => ({
  appId: "Spotify.exe", app: "Spotify", title: "A", artist: "B", album: "C", playing: true,
  canPrev: true, canNext: true, canToggle: true, positionMs: 10_000, durationMs: 100_000, at: 1_000, art: null, ...o,
});

test("positionAt: moves while playing, stays when paused, clamps to the length", () => {
  assert.equal(positionAt(T(), 3_000), 12_000);
  assert.equal(positionAt(T({ playing: false }), 9_000), 10_000);
  assert.equal(positionAt(T({ positionMs: 99_000 }), 9_000), 100_000);
  assert.equal(positionAt(T({ positionMs: null }), 9_000), null);
  assert.equal(positionAt(T({ durationMs: null }), 3_000), 12_000);
  assert.equal(positionAt(T(), 0), 10_000); // clock before the report
});

test("fraction: null (progress hidden) when the length is unknown", () => {
  assert.equal(fraction(T({ durationMs: null }), 2_000), null);
  assert.equal(fraction(T({ positionMs: null }), 2_000), null);
  assert.equal(fraction(T({ durationMs: 0 }), 2_000), null);
  assert.equal(fraction(T(), 6_000), 0.15);
});

test("clock formats m:ss and h:mm:ss", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(185_000), "3:05");
  assert.equal(clock(3_723_000), "1:02:03");
  assert.equal(clock(-5), "0:00");
});

test("wantCapture: only with a viewer", () => {
  const base = { playing: true, paused: false, mode: "compact", view: "x", dance: true };
  assert.equal(wantCapture(base), true);
  assert.equal(wantCapture({ ...base, playing: false }), false);
  assert.equal(wantCapture({ ...base, paused: true }), false);
  assert.equal(wantCapture({ ...base, mode: "hidden" }), false);
  assert.equal(wantCapture({ ...base, dance: false }), false);
  assert.equal(wantCapture({ ...base, dance: false, mode: "expanded", view: "nowplaying" }), true);
  assert.equal(wantCapture({ ...base, dance: false, mode: "compact", view: "nowplaying" }), false);
});

test("levels are clamped and scaled by sensitivity", () => {
  assert.equal(clampSens(9), 2);
  assert.equal(clampSens(0), 0.5);
  assert.equal(clampSens("x"), 1);
  assert.equal(danceLevel(0.5, 1), 0.8);
  assert.equal(danceLevel(2, 2), 1);
  assert.equal(danceLevel(NaN, 1), 0);
  assert.deepEqual(shapeBands([0.2, 1, -1], 2), [0.4, 1, 0]);
});

test("trackKey ignores position, cover and play state; trackLine falls back", () => {
  assert.equal(trackKey(T()), trackKey(T({ positionMs: 5, playing: false, art: "x" })));
  assert.notEqual(trackKey(T()), trackKey(T({ title: "Z" })));
  assert.equal(trackKey(null), "");
  assert.equal(trackLine(T()), "A · B");
  assert.equal(trackLine(T({ artist: "" })), "A");
  assert.equal(trackLine(T({ artist: "", title: "" })), "Spotify");
});

test("remaining: time left, empty when the length or position is unknown", () => {
  assert.equal(remaining(T(), 1_000), "-1:30");
  assert.equal(remaining(T(), 5_000), "-1:26");
  assert.equal(remaining(T({ playing: false }), 99_000), "-1:30"); // paused: frozen
  assert.equal(remaining(T({ durationMs: null }), 1_000), "");
  assert.equal(remaining(T({ positionMs: null }), 1_000), "");
  assert.equal(remaining(T({ positionMs: 100_000 }), 1_000), "-0:00");
});

test("compactCard: cover, title, artist, time left; dimmed when paused; falls back to the app name", () => {
  assert.deepEqual(compactCard(T({ art: "data:x" }), 1_000), { text: "A", card: { art: "data:x", sub: "B", trail: "-1:30", dim: false } });
  assert.equal(compactCard(T({ playing: false }), 1_000).card.dim, true);
  assert.equal(compactCard(T({ title: "" }), 1_000).text, "Spotify");
});

test("wantTick: only while playing and the time is on screen", () => {
  const b = { playing: true, mode: "compact", view: "x", hasLength: true, cardShown: true };
  assert.equal(wantTick(b), true);
  assert.equal(wantTick({ ...b, cardShown: false }), false, "compact but the card is not on show");
  assert.equal(wantTick({ ...b, hasLength: false }), false);
  assert.equal(wantTick({ ...b, playing: false }), false);
  assert.equal(wantTick({ ...b, mode: "hidden" }), false);
  assert.equal(wantTick({ ...b, paused: true }), false);
  assert.equal(wantTick({ ...b, mode: "expanded" }), false);
  assert.equal(wantTick({ ...b, mode: "expanded", view: "nowplaying", hasLength: false }), true);
});
