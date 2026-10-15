// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { App } from "../kit/app";
import { IS_TAURI, command, commandOrThrow, onEvent } from "../kit/tauri";
import type { Settings } from "./state";

export { IS_TAURI, command, commandOrThrow, onEvent };

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
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    command<void>("set_island_rect", { x, y, width, height }),

  reposition: () => command<void>("reposition"),


  /** The section the settings window was opened for, once ("" for none). */
  takeSettingsSection: () => command<string>("take_settings_section"),

  /** Pretty JSON of the settings without secret-looking keys. */
  exportSettings: () => command<string>("settings_export"),

  /** Leaves safe mode: true when the stored module switches are back in effect. */
  safeModeExit: () => command<boolean>("safe_mode_exit"),

  /** Tray → Pause. */
  setPaused: (paused: boolean) => command<void>("set_paused", { paused }),
};

