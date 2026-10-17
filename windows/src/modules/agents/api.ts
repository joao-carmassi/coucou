// Types only. Provider modules `provide` these services; consumers pull them.
export interface AgentInfo { id: string; label: string; color: string; installed: boolean; hooked: boolean; blocking: boolean; live: number }
export type AgentsList = () => readonly AgentInfo[];   // providers: agents + claude; consumers merge useAll by id
export interface UsageWindow { label: string; usedPct: number | null; resetsAt: number | null; tokens?: number }
export interface AgentUsage { agent: string; windows: readonly UsageWindow[]; source: "local" | "network"; at: number; error?: string }
export type AgentsUsage = (agent?: string) => Promise<readonly AgentUsage[]>;  // provider planusage; network only when opt-in key on
export const AGENTS_SERVICE = { list: "agents.list", usage: "agents.usage" } as const;
