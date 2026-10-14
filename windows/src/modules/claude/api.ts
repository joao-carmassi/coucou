// What the Claude module offers other modules (services, via api.provide / api.use). Types only.
// The per-pill cards and news live in the board's api (modules/board/api.ts): Claude provides
// `board.card` for its own pill, like every module does for the pills it owns.

export type LaunchFile = (path: string, ingest: boolean) => Promise<void>;

export const CLAUDE_SERVICE = {
  launchFile: "claude.launchFile",
} as const;
