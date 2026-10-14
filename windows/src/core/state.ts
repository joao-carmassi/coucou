// App state — the parts the island needs. Core only: modules plug in later.

import { Hooks } from "./hooks";
import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import { applyBadge, type PillBadge } from "./badge";
export type { PillBadge };

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
}

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
  tasks: AgentTask[] = [];
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
    if (applyBadge(this.tasks, id, badge)) this.notify();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? this.avatarState;
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusTask?.id);
  }

  /** The home view: what the strongest module asks for (Hooks.home), else the empty card. */
  defaultView(): IslandViewName {
    return Hooks.home(false)?.view ?? "empty";
  }
}

export const State = new AppState();
