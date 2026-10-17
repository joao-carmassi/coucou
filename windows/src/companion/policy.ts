// Frame policy of the companion window (pure). The window is a second webview, and with
// CalculateNativeWinOcclusion off an occluded page is NOT throttled by Chromium: this is the only brake.

export type FrameMode = "stop" | "raf" | "tick";

/** Idle redraw interval: 10 fps is enough for a breathing Mochi. */
export const IDLE_TICK_MS = 100;

/**
 * hidden (full screen, call, pause)      -> stop: no loop at all, a new message re-arms it
 * active (tween, particle, level, drag)  -> raf
 * only a looping mood (breathe, zz...)   -> tick at IDLE_TICK_MS
 * nothing moves                          -> stop
 */
export function frameMode(i: { hidden: boolean; active: boolean; busy: boolean }): FrameMode {
  if (i.hidden) return "stop";
  if (i.active) return "raf";
  return i.busy ? "tick" : "stop";
}

/** What the island tells the companion; a missing field means "unchanged". */
export interface AvatarMsg {
  state?: string;
  /** #rrggbb body colour, null = the default gradient. */
  color?: string | null;
  emote?: string;
  /** 0..1 loudness; sent at most 15 times a second and only while above zero (plus one 0). */
  level?: number;
  dance?: boolean;
  /** The island would be hidden (presence quiet) or paused: draw nothing, run nothing. */
  hidden?: boolean;
}

export const LEVEL_SEND_GAP_MS = 66;

/** Island side: is this loudness worth a message? */
export function levelDue(v: number, lastSent: number, sinceMs: number): boolean {
  if (v > 0) return sinceMs >= LEVEL_SEND_GAP_MS;
  return lastSent > 0; // exactly one 0 after the loudness ends
}
