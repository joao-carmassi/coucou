// Mochi's moods and emotes as data. The 11 built-ins are rows here; a module adds its own
// through api.avatar.defineMood / defineEmote (names are "<moduleId>.<local>"). Pure: no DOM.
import type { BuiltinMood } from "../core/layout";

export type EyeShape =
  | "pill" | "wide" | "dot" | "line" | "flat" | "happy" | "closed"
  | "spiral" | "heart" | "star" | "tired" | "wink" | "cup";
export type BadgeKind = "dots" | "bang" | "question" | "dot";
export type Enter = "none" | "blink" | "hop" | "shake" | "roll" | "roll2" | "spark-roll" | "sweat";

export interface MoodDef {
  /** Body colour, #RRGGBB. */
  color: string;
  tint?: number;
  eye: EyeShape;
  /** Badge colour defaults to `color`. */
  badge?: { kind: BadgeKind; color?: string } | null;
  /** The glow behind Mochi in the expanded island. Default: `color` at 0.65. */
  glow?: { color: string; opacity: number };
  motion?: {
    bounces?: boolean; scans?: boolean; breathes?: boolean; zz?: boolean; sweat?: boolean;
    look?: readonly [number, number]; tilt?: number;
  };
  /** Played once when Mochi takes the mood. Default "blink". */
  enter?: Enter;
  /** Sound played on entering (a core sound or one this module registered). */
  sound?: string;
}

export interface EmoteDef {
  eye: EyeShape;
  /** How long the eyes stay changed. Default 1800. */
  ms?: number;
  particles?: { kind: "heart" | "star" | "spark" | "z"; n: number };
  blush?: number;
  motion?: "hop" | "tilt" | "squash" | "none";
  sound?: string;
}

const W = { color: "#FFFFFF", opacity: 0.65 };
const g = (color: string) => ({ color, opacity: 0.65 });

export const BUILTIN_MOODS: Record<BuiltinMood, MoodDef> = {
  idle: { color: "#E6E9EE", tint: 0, eye: "pill", glow: { color: "#FFFFFF", opacity: 0.15 } },
  working: { color: "#3B9EFF", tint: 0.72, eye: "pill", badge: { kind: "dots" }, glow: g("#3B9EFF") },
  thinking: { color: "#8B5CF6", tint: 0.72, eye: "pill", badge: { kind: "dots" }, motion: { look: [0.55, 0.55] }, glow: g("#A78BFA") },
  searching: { color: "#6365F2", tint: 0.72, eye: "pill", badge: { kind: "dots" }, motion: { scans: true }, glow: g("#6366F1") },
  alert: { color: "#F5A524", tint: 0.78, eye: "wide", badge: { kind: "bang" }, motion: { bounces: true }, glow: g("#F5A524"), enter: "hop" },
  ask: { color: "#22D3EE", tint: 0.75, eye: "pill", badge: { kind: "question" }, motion: { tilt: 0.17 }, glow: W, enter: "blink" },
  error: { color: "#F4505E", tint: 0.78, eye: "flat", badge: { kind: "dot" }, glow: g("#F4505E"), enter: "shake" },
  done: { color: "#34D499", tint: 0.35, eye: "happy", badge: { kind: "dot" }, glow: g("#34D399"), enter: "spark-roll" },
  waiting: { color: "#FB923C", tint: 0.72, eye: "tired", badge: { kind: "dot" }, motion: { sweat: true }, glow: g("#F59E0B"), enter: "sweat" },
  sleeping: { color: "#94A2B8", tint: 0.32, eye: "closed", motion: { breathes: true, zz: true }, glow: { color: "#FFFFFF", opacity: 0.15 } },
  dizzy: { color: "#F472B6", tint: 0.7, eye: "spiral", glow: { color: "#FFFFFF", opacity: 0 }, enter: "roll2" },
};

const custom = new Map<string, MoodDef>();
let version = 0;
/** Bumped whenever a custom mood is added, replaced or removed: a sprite re-reads its mood when this changes. */
export const moodVersion = () => version;
const customEmotes = new Map<string, EmoteDef>();

const own = (name: string): name is BuiltinMood => Object.hasOwn(BUILTIN_MOODS, name);

/** The mood's definition; idle when the name is unknown (a module stopped, a typo). */
export function moodOf(name: string): MoodDef {
  return (own(name) ? BUILTIN_MOODS[name] : custom.get(name)) ?? BUILTIN_MOODS.idle;
}

export const hasMood = (name: string) => own(name) || custom.has(name);

/** The glow for a mood: always defined. */
export function glowOf(name: string): { color: string; opacity: number } {
  const m = moodOf(name);
  return m.glow ?? { color: m.color, opacity: 0.65 };
}

const HEX = /^#[0-9a-f]{6}$/i;
const bad = (owner: string, what: string, c: unknown) => {
  if (typeof c !== "string" || !HEX.test(c)) throw new Error(`module "${owner}": ${what} must be a #RRGGBB colour, got ${JSON.stringify(c)}`);
};
/** Throws (naming the module) when a colour of a mood is not #RRGGBB. */
export function checkMood(owner: string, local: string, def: MoodDef) {
  const w = `mood "${local}"`;
  bad(owner, `${w} color`, def.color);
  if (def.badge?.color !== undefined) bad(owner, `${w} badge.color`, def.badge.color);
  if (def.glow) bad(owner, `${w} glow.color`, def.glow.color);
}

/** Registers a module's mood; the returned function removes it (only if it is still this definition). */
export function registerMood(name: string, def: MoodDef): () => void {
  custom.set(name, def);
  version++;
  return () => { if (custom.get(name) === def) { custom.delete(name); version++; } };
}

export const emoteDefOf = (name: string): EmoteDef | undefined => customEmotes.get(name);

export function registerEmote(name: string, def: EmoteDef): () => void {
  customEmotes.set(name, def);
  return () => { if (customEmotes.get(name) === def) customEmotes.delete(name); };
}
