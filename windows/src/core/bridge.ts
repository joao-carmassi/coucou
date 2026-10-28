// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { App } from "../kit/app";
import { IS_TAURI, command, commandOrThrow, onEvent } from "../kit/tauri";
import type { Settings } from "./state";

export { IS_TAURI, command, commandOrThrow, onEvent };

/** `quiet` already includes `mic`: a full-screen app, presentation, quiet hours or a call. */
export interface Presence { quiet: boolean; mic: boolean }

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  /** Which modules are on (resolved by Rust). */
  modules: Record<string, boolean>;
  /** True when repeated unclean starts put this run in safe mode (only the safe module set is on, in memory). */
  safeMode: boolean;
}

export const Bridge = {
  ...App,

  boot: () => command<BootInfo>("boot"),

  /** Rust merges these top-level keys onto the stored settings: keys not given are never touched. */
  saveSettings: (patch: Partial<Settings> | Record<string, unknown>) => command<void>("save_settings", { patch }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => command<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number, compact: boolean) =>
    command<void>("set_island_rect", { x, y, width, height, compact }),

  /** Alt+press on the compact island: Rust follows the cursor, saves on release and emits "island-drag-end". */
  beginIslandDrag: () => command<void>("begin_island_drag"),

  centerIsland: () => command<void>("center_island"),

  reposition: () => command<void>("reposition"),
  /** The palette hotkey remembered the focused window but the palette did not open: drop it. */
  forgetForeground: () => command<void>("forget_foreground"),


  /** The section the settings window was opened for, once ("" for none). */
  takeSettingsSection: () => command<string>("take_settings_section"),

  /** Turns the OS presence watch on or off (one subscriber); on, it answers with the current state. */
  presenceWatch: (on: boolean) => command<Presence>("presence_watch", { on }),
  /** The current state, read once (no watch). */
  presenceNow: () => command<Presence>("presence_now"),
  /** A full-screen app, a presentation or quiet hours is in front (the mic does not count); null outside Tauri. */
  fullScreen: () => command<boolean>("presence_full_screen"),

  /** Pretty JSON of the settings without secret-looking keys. */
  exportSettings: () => command<string>("settings_export"),

  /** Leaves safe mode: true when the stored module switches are back in effect. */
  safeModeExit: () => command<boolean>("safe_mode_exit"),

  /** Tray → Pause. */
  setPaused: (paused: boolean) => command<void>("set_paused", { paused }),
};

