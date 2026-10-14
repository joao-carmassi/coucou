// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type CoreViewName = "empty" | "confused" | "note" | "settings" | "greeting";
/** Core views plus whatever modules register. */
export type IslandViewName = string;

export type BotStateName =
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

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
  /** Room for a news line under the card. */
  newsLine?: boolean;
  /** Extra height (px) for a proposal row. */
  proposalRoom?: number;
  /** The bot follows botX but stays inside [from, from + span]. */
  botTrack?: { from: number; span: number };
  /** false = no glow behind the bot. */
  glow?: false;
}

// The window is a fixed 720×320 (largest view) like the macOS panel; the island is
// drawn inside it, glued to the top edge and horizontally centred.
export const PANEL_W = 720;
export const PANEL_H = 320;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104 — only islandSize's default still uses it
export const EXPANDED_W = 640;

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

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<string, ViewLayout> = {
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
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
      const h = fitted ?? l.height + (l.proposalRoom ?? 0);
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
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "alert":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "done":
      return "#34D399";
    case "waiting":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
