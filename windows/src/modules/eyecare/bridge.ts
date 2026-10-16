import { command } from "../../kit/tauri";
import type { Days } from "./logic";

export const EyecareBridge = {
  /** Cuts the open screen-time segment; answers the ms since the last keyboard or mouse input (null outside Tauri). */
  checkpoint: () => command<number>("eyecare_checkpoint"),
  /** day -> exe -> seconds; a fresh checkpoint first. */
  usage: async (): Promise<Days> => (await command<Days>("eyecare_usage")) ?? {},
  /** Erases every counter, in memory and on disk. */
  clear: () => command<void>("eyecare_clear"),
};
