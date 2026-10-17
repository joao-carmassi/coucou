import { command } from "../../kit/tauri";
import type { Summary } from "./logic";

export const AistatsBridge = {
  /** Reads what the logs gained since the last call (up to 2 s of work); `more` says to call again. Null outside Tauri. */
  refresh: () => command<Summary>("aistats_refresh"),
  /** Erases the stored counters (the logs of the tools are never touched). */
  clear: () => command<void>("aistats_clear"),
};
