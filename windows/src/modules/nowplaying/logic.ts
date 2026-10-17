// Pure rules of the Tocando agora module (no DOM, no Tauri): Node tests load this file.

/** What the Rust worker reports about the player (src-tauri/src/modules/nowplaying/session.rs). */
// Fixed parts of the Tocando view (nowplaying.css), so the island fits its content without measuring: chrome 56 (as sysmon) +
// body padding 14 + 14, cover row 56, gap 6, progress (bar 4 + 2 + times 13) 19, gap 6, controls 28. Without a known length the progress and its gap go.
export const fitHeight = (progress: boolean): number => 56 + 28 + 56 + 6 + 28 + (progress ? 6 + 19 : 0);

export interface Track {
  appId: string;
  app: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  canPrev: boolean;
  canNext: boolean;
  canToggle: boolean;
  /** Where the track was at `at`; null when the player gives no timeline. */
  positionMs: number | null;
  /** null for streams of unknown length (most browsers): the progress bar is hidden. */
  durationMs: number | null;
  /** Unix ms `positionMs` is valid for. */
  at: number;
  /** Small JPEG data URL, or null. */
  art: string | null;
}

export interface Cfg { nowplayingDance: boolean; nowplayingSensitivity: number }

export const SENS_MIN = 0.5;
export const SENS_MAX = 2;

export const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function clampSens(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(SENS_MAX, Math.max(SENS_MIN, n)) : 1;
}

/** Same track? (the cover and position do not count). */
export const trackKey = (t: Track | null) => (t ? `${t.appId}\u0001${t.title}\u0001${t.artist}\u0001${t.album}` : "");

/** Position now, moved forward from the report while playing and kept inside the length. null: no timeline. */
export function positionAt(t: Track, now: number): number | null {
  if (t.positionMs === null) return null;
  const moved = t.playing ? Math.max(0, now - t.at) : 0;
  const p = Math.max(0, t.positionMs + moved);
  return t.durationMs === null ? p : Math.min(p, t.durationMs);
}

/** "3:05", "1:02:03". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** Progress 0..1, or null when the length is unknown (the bar is then hidden). */
export function fraction(t: Track, now: number): number | null {
  const p = positionAt(t, now);
  return p === null || t.durationMs === null || t.durationMs <= 0 ? null : clamp01(p / t.durationMs);
}

/**
 * The loopback runs only while someone looks at the result: something is playing, Pause is off, the island is not
 * hidden, and either the Mochi dance is on or the player's own view is open.
 */
export function wantCapture(o: { playing: boolean; paused: boolean; mode: string; view: string; dance: boolean }): boolean {
  if (!o.playing || o.paused || o.mode === "hidden") return false;
  return o.dance || (o.mode === "expanded" && o.view === "nowplaying");
}

/** Mochi loudness: the mean level of the bands is low for real music, so it is lifted, then scaled by the sensitivity. */
export const danceLevel = (level: number, sens: number) => clamp01(level * 1.6 * clampSens(sens));

/** Bars for the view: each band scaled by the sensitivity. */
export const shapeBands = (bands: readonly number[], sens: number) => bands.map((b) => clamp01(b * clampSens(sens)));

/** Time left, "-3:05"; "" when the length or the position is unknown. */
export function remaining(t: Track, now: number): string {
  const p = positionAt(t, now);
  return p === null || t.durationMs === null || t.durationMs <= 0 ? "" : `-${clock(t.durationMs - p)}`;
}

/** The compact island's card for a track (cover, title, artist, time left; dimmed while paused). Pure. */
export function compactCard(t: Track, now: number) {
  return { text: t.title || t.app, card: { art: t.art, sub: t.artist, trail: remaining(t, now), dim: !t.playing } };
}

/** The 1 s tick is needed only while the playing track's time (compact) or progress bar (open player) is on screen. */
export function wantTick(o: { playing: boolean; paused?: boolean; mode: string; view: string; hasLength: boolean; cardShown?: boolean }): boolean {
  if (!o.playing || o.paused) return false;
  return (o.mode === "compact" && o.hasLength && o.cardShown === true) || (o.mode === "expanded" && o.view === "nowplaying");
}
