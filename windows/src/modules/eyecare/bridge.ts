import { command } from "../../kit/tauri";
import { NO_BREAKS, type Breaks, type Days } from "./logic";

export interface Checkpoint { idle: number; quiet: boolean }

export const EyecareBridge = {
  /** Cuts the open screen-time segment; answers the ms since the last input and whether the user is busy (null outside Tauri). */
  checkpoint: () => command<Checkpoint>("eyecare_checkpoint"),
  /** day -> exe -> seconds; a fresh checkpoint first. */
  usage: async (): Promise<Days> => (await command<Days>("eyecare_usage")) ?? {},
  /** Counts one reminder round of today; `taken` = the user was already away (a break). */
  mark: (taken: boolean) => command<void>("eyecare_break", { taken }),
  /** Break rounds per day and the time of the last break. */
  breaks: async (): Promise<Breaks> => (await command<Breaks>("eyecare_breaks")) ?? NO_BREAKS,
  /** Erases every counter, in memory and on disk. */
  clear: () => command<void>("eyecare_clear"),
};
