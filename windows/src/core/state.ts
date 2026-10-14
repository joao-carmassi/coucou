// App state — the parts the island needs. Core only: modules plug in later.

import { Hooks, homeOf } from "./hooks";
import type { TabDef } from "./moduleApi";
import type { BotEmoteName, BotStateName, IslandMode, IslandViewName, LegacyMoodName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import { applyBadge, type LegacyBadgeName, type PillBadge } from "./badge";
export type { PillBadge };

/** A mini Mochi in the compact grid / pill row. Neutral: any module may own some (api.pills). */
export interface Pill {
  id: string;
  label: string;
  color: string;
  mood: BotStateName;
  emote?: BotEmoteName | null;
  eye?: EyeShape | null;
  badge?: PillBadge | null;
  /** Module id, stamped by api.pills; never set by hand. */
  owner?: string;
}
/** A new pill needs label and color; later calls patch fields (null clears emote / eye / badge). */
export type PillPatch = Pick<Pill, "id"> & Partial<Omit<Pill, "id" | "owner">>;
/** What api.pills.set takes: a PillPatch that also accepts the old mood / badge names for one version. */
export type PillInput = Omit<PillPatch, "mood" | "badge"> & { mood?: BotStateName | LegacyMoodName; badge?: PillBadge | LegacyBadgeName | null };
/** Where a new pill goes: default the end. `after`: missing anchor = start; `before`: missing anchor = end. */
export type PillAt = "start" | { after: string } | { before: string };

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Seconds minimized before hiding; 0 = never. */
  compactHideInterval: number;
  absenceInterval: number;
  screen: "primary" | "cursor";
  autostart: boolean;
  /** Per-module switches; a missing key means the module default. */
  modulesEnabled: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  compactHideInterval: 60,
  absenceInterval: 180,
  screen: "primary",
  autostart: false,
  modulesEnabled: {},
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "empty";

  /** Effective on/off of every module (Registry.apply). */
  modules: Record<string, boolean> = {};

  /** Mini Mochis shown in the compact grid; empty until a module adds some. */
  pills: Pill[] = [];
  focusId: string | null = null;

  /** What the avatar wears while nothing else decides: set it and `notify()`. */
  avatarState: BotStateName = "idle";
  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  noteMessage: string | null = null;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    if (applyBadge(this.pills, id, badge)) this.notify();
  }

  get focusPill(): Pill | null {
    return this.pills.find((t) => t.id === this.focusId) ?? this.pills[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusPill?.mood ?? this.avatarState;
  }

  get otherPills(): Pill[] {
    return this.pills.filter((t) => t.id !== this.focusPill?.id);
  }

  /** Tabs of the running modules, in order; the home falls back to the first. */
  tabs: TabDef[] = [];

  /** The home view: what the strongest module asks for (Hooks.home), else the empty card. */
  defaultView(): IslandViewName {
    return homeOf(Hooks.home(false), this.tabs);
  }
}

export const State = new AppState();
