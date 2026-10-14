// What the Claude module offers other modules (services, via api.provide / api.use). Types only.

/** A card a module draws for a pill it owns, in the Claude overview's left card, dressed in the host's tile-* classes (claude/panel.css); `key` changes when it must be redrawn. */
export interface TaskCard { key: string; build(): HTMLElement }
/** News a module's pill tells: the finished and error cards show it in place of a session's result. */
export interface TaskNews { says: string; title: string; facts: Node[] }

export type LaunchFile = (path: string, ingest: boolean) => Promise<void>;
/** Offered by OTHER modules for pills they own; Claude asks every provider and takes the first non-null answer. */
export type TaskCardOf = (taskId: string) => TaskCard | null;
export type TaskNewsOf = (taskId: string) => TaskNews | null;

export const CLAUDE_SERVICE = {
  launchFile: "claude.launchFile",
  taskCard: "claude.taskCard",
  taskNews: "claude.taskNews",
} as const;

/** The first non-null answer of the providers of a per-pill service (a throwing provider is skipped). */
export function askPill<T>(providers: ((taskId: string) => T | null)[], taskId: string): T | undefined {
  for (const p of providers) {
    try { const r = p(taskId); if (r) return r; } catch (err) { console.error("[coucou] pill service failed", err); }
  }
  return undefined;
}
