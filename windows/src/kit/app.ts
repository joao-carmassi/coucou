// What the app lends to anyone: log, open a link, open the settings window, take the window's focus,
// copy a file into the inbox. Kit rule: no core/ or island/ value imports.

import { command, commandOrThrow } from "./tauri";

export const App = {
  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => command<void>("log_line", { message }),

  openUrl: (url: string) => command<void>("open_url", { url }),

  openSettingsWindow: () => command<void>("open_settings_window"),

  /** Give the window keyboard focus and take it away again. */
  focusWindow: (focused: boolean) => command<void>("focus_window", { focused }),

  /** Copies a file into the inbox (sweeps old ones, emits `inbox-added`); rejects with the reason. */
  inboxIngest: (path: string) => commandOrThrow<{ name: string; path: string; size: number }>("inbox_ingest", { path }),
};
