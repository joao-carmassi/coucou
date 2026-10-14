// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function command<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  /** Which modules are on (resolved by Rust). */
  modules: Record<string, boolean>;
}

export const Bridge = {
  boot: () => command<BootInfo>("boot"),

  /** Rust merges these top-level keys onto the stored settings: keys not given are never touched. */
  saveSettings: (patch: Partial<Settings> | Record<string, unknown>) => command<void>("save_settings", { patch }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => command<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    command<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus and take it away again. */
  focusWindow: (focused: boolean) => command<void>("focus_window", { focused }),

  reposition: () => command<void>("reposition"),

  openUrl: (url: string) => command<void>("open_url", { url }),

  quit: () => command<void>("quit_app"),

  openSettingsWindow: () => command<void>("open_settings_window"),

  /** The section the settings window was opened for, once ("" for none). */
  takeSettingsSection: () => command<string>("take_settings_section"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => command<void>("log_line", { message }),

  /** Copies a file into the inbox (sweeps old ones, emits `inbox-added`); rejects with the reason. */
  inboxIngest: (path: string) => commandOrThrow<{ name: string; path: string; size: number }>("inbox_ingest", { path }),

  /** Tray → Pause. */
  setPaused: (paused: boolean) => command<void>("set_paused", { paused }),
};

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  /** `end`: the drag finished without a drop on the island. */
  type: "enter" | "over" | "drop" | "leave" | "end";
  paths?: string[];
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 * Comes from Coucou's own drop target (drop_target.rs), not Tauri's: WebView2
 * replaces the one wry installs with a target that refuses every file.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

/** Same as `command`, but surfaces the error so the UI can show what went wrong. */
export async function commandOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

