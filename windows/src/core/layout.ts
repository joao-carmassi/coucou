// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.
import { EXPANDED_W } from "./moduleApi";

export type IslandMode = "hidden" | "compact" | "expanded";

/** Core views plus whatever modules register. */
export type IslandViewName = string;

export type BuiltinMood =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "alert"
  | "ask"
  | "error"
  | "done"
  | "waiting"
  | "sleeping"
  | "dizzy";

/** A built-in mood, or one a module defined ("<moduleId>.<name>"; unknown ones draw as idle). */
export type BotStateName = BuiltinMood | `${string}.${string}`;

export type BuiltinEmote = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";
export type BotEmoteName = BuiltinEmote | `${string}.${string}`;

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  /** Extra height (px) added to `height`. */
  extraHeight?: number;
  /** The bot follows botX but stays inside [from, from + span]. */
  botTrack?: { from: number; span: number };
  /** false = no glow behind the bot. */
  glow?: false;
  /** Fixed card the auto-centred bot sits beside: `top` = y of its top edge, `h` = its height. Default {top:42,h:84}. */
  botCenter?: { top: number; h: number };
}

// The window is a fixed 720×320 (largest view) like the macOS panel; the island is
// drawn inside it, glued to the top edge and horizontally centred.
export const PANEL_W = 720;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104 — only islandSize's default still uses it

// The compact island fits its content: padding | bot | gap | (mini grid or text) | padding.
export const COMPACT_PAD = 14;
export const COMPACT_BOT_D = 22;
export const COMPACT_BOT_CX = COMPACT_PAD + COMPACT_BOT_D / 2;
export const COMPACT_GAP = 10;
export const COMPACT_CONTENT_X = COMPACT_PAD + COMPACT_BOT_D + COMPACT_GAP;
export const COMPACT_MAX_W = 360; // text gets an ellipsis beyond this
export const MINI = 13;
export const MINI_GAP = 3;

/** Size of the mini grid for n other tasks (1 → 13×13, 2 → 29×13, 3-4 → 29×29). */
export function miniGridSize(n: number): { w: number; h: number } {
  if (n <= 0) return { w: 0, h: 0 };
  const c = Math.min(2, n);
  const r = n > 2 ? 2 : 1;
  return { w: c * MINI + (c - 1) * MINI_GAP, h: r * MINI + (r - 1) * MINI_GAP };
}

/** Width of the compact island: bare when idle, grown for the grid or the status text. */
export function compactWidth(others: number, textW: number): number {
  const base = 2 * COMPACT_PAD + COMPACT_BOT_D;
  if (others > 0) return base + COMPACT_GAP + miniGridSize(others).w;
  // Snapped to 8 px so a pixel or two between labels doesn't make the island twitch.
  if (textW > 0) return Math.min(COMPACT_MAX_W, base + COMPACT_GAP + Math.ceil((textW + 1) / 8) * 8);
  return base;
}

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;


export const VIEW_LAYOUTS: Record<string, ViewLayout> = {
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62 },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66 },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50 },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46 },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0 },
};

/** Never index VIEW_LAYOUTS directly: a view may be unregistered. */
export function viewLayout(v: string): ViewLayout {
  return VIEW_LAYOUTS[v] ?? VIEW_LAYOUTS.empty;
}

export function registerLayout(v: string, layout: ViewLayout): () => void {
  VIEW_LAYOUTS[v] = layout;
  return () => {
    if (VIEW_LAYOUTS[v] === layout) delete VIEW_LAYOUTS[v];
  };
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  fitted: number | null = null,
  compactW = COMPACT_W,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      // Same width as compact, so opening and closing only move the height.
      return { w: compactW, h: 0 };
    case "compact":
      return { w: compactW, h: NOTCH_H };
    case "expanded": {
      const l = viewLayout(view);
      const h = fitted ?? l.height + (l.extraHeight ?? 0);
      return { w: EXPANDED_W, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: COMPACT_BOT_CX, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: COMPACT_BOT_CX, cy: 16, diameter: COMPACT_BOT_D, opacity: 1 };
    case "expanded": {
      const layout = viewLayout(view);
      const t = layout.botTrack;
      const cx = t ? Math.min(t.from + t.span, Math.max(t.from, layout.botX)) : layout.botX;
      if (layout.botY != null) {
        return { cx, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Default: centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const { top: headerBottom, h: cardH } = layout.botCenter ?? { top: 42, h: 84 };
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}
