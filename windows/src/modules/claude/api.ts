// What the Claude module offers other modules (services, via api.provide / api.use). Types only.
// The per-pill cards and news live in the board's api (modules/board/api.ts): Claude provides
// `board.card` for its own pill, like every module does for the pills it owns.

export type LaunchFile = (path: string, ingest: boolean) => Promise<void>;
/** A NEW session in the default profile, started with this prompt (voice sends its transcript here). */
export type LaunchPrompt = (prompt: string) => Promise<void>;

export const CLAUDE_SERVICE = {
  launchFile: "claude.launchFile",
  launchPrompt: "claude.launchPrompt",
} as const;
