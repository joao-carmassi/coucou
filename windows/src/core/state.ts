// App state — the parts the island needs. Core only: modules plug in later.

import { Compact } from "./compact";
import { Hooks, homeOf } from "./hooks";
import { Requests } from "./requests";
import type { TabDef } from "./moduleApi";
import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/moods";
import { applyBadge, type PillBadge } from "./badge";
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
  /** Nothing to say: still listed with the rest, but never takes the compact grid nor hides the status line. */
  ambient?: boolean;
}
/** A new pill needs label and color; later calls patch fields (null clears emote / eye / badge). */
export type PillPatch = Pick<Pill, "id"> & Partial<Omit<Pill, "id" | "owner">>;
/** What api.pills.set takes: a PillPatch that also accepts the old mood / badge names for one version. */
export type PillInput = Omit<PillPatch, "mood" | "badge"> & { mood?: BotStateName; badge?: PillBadge | null };
/** Where a new pill goes: default the end. `after`: missing anchor = start; `before`: missing anchor = end. */
export type PillAt = "start" | { after: string } | { before: string };

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Seconds minimized before hiding; 0 = never. */
  compactHideInterval: number;
  /** Minutes a held task view stays the place the island reopens on; 0 = off. */
  focusHoldMinutes: number;
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
  focusHoldMinutes: 1,
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
  /** The pill in front. Modules read it and ask through api.pills.focus; core/pills.ts is the only writer. */
  focusId: string | null = null;

  /** What the avatar wears while nothing else decides: set it and `notify()`. */
  avatarState: BotStateName = "idle";
  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  /** Read-only: the front module request pins the island while it is open (core/requests.ts). */
  get isPinned(): boolean {
    return this.mode === "expanded" && Requests.pinned();
  }
  /** Read-only to modules (api.paused / api.onPause); main.ts flips it through setPaused. */
  private _paused = false;
  private pauseListeners = new Set<(paused: boolean) => void>();
  get paused(): boolean {
    return this._paused;
  }
  /** True when the value changed (listeners have run). */
  setPaused(on: boolean): boolean {
    if (this._paused === on) return false;
    this._paused = on;
    for (const fn of [...this.pauseListeners]) {
      try { fn(on); } catch (err) { console.error("[coucou] onPause failed", err); }
    }
    return true;
  }
  onPause(fn: (paused: boolean) => void): () => void {
    this.pauseListeners.add(fn);
    return () => void this.pauseListeners.delete(fn);
  }

  noteMessage: string | null = null;

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

  /**
   * The other pills in the compact grid. While a status line is on show the ambient ones stay out
   * (only pills with something to say compete); with no line on show, every pill is listed.
   */
  get gridPills(): Pill[] {
    return this.statusLine ? this.otherPills.filter((p) => !p.ambient) : this.otherPills;
  }

  /** The compact status line on show: only the non-ambient pills can hide it (an overGrid line never hides). */
  get statusLine() {
    return Compact.resolve(this.otherPills.filter((p) => !p.ambient).length);
  }

  get otherPills(): Pill[] {
    return this.pills.filter((t) => t.id !== this.focusPill?.id);
  }

  /** Tabs of the running modules, in order; the home falls back to the first. */
  tabs: TabDef[] = [];

  /** The home view: what the strongest module asks for (Hooks.home), else the empty card. */
  defaultView(): IslandViewName {
    return homeOf(Hooks.home(), this.tabs);
  }
}

export const State = new AppState();
