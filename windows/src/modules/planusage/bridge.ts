import { commandOrThrow } from "../../kit/tauri";
import type { AgentUsage } from "../agents/api";

export const planusageBridge = {
  get: () => commandOrThrow<AgentUsage[]>("planusage_get"),
  claude: () => commandOrThrow<AgentUsage>("planusage_claude"),
};
