import { command, commandOrThrow } from "../../kit/tauri";
import type { AgentInfo } from "./api";

/** What Rust says about an agent, plus where its hook file is. */
export interface AgentRow extends AgentInfo { configPath: string }
export interface HookPreview { diff: string; backup: string; settingsPath: string; fingerprint: string }

export const AgentsBridge = {
  list: async (): Promise<AgentRow[]> => (await command<AgentRow[]>("agents_list")) ?? [],
  preview: (agent: string, install: boolean) => commandOrThrow<HookPreview>("agents_preview", { agent, install }),
  apply: (agent: string, install: boolean, fingerprint: string) => commandOrThrow<string>("agents_apply", { agent, install, fingerprint }),
  ack: (requestId: string) => command<void>("agents_ack", { requestId }),
  decline: (requestId: string) => command<void>("agents_decline", { requestId }),
  /** Exactly "allow" or "deny"; Rust declines anything else. */
  decide: (requestId: string, word: "allow" | "deny") => command<void>("agents_decide", { requestId, word }),
};
