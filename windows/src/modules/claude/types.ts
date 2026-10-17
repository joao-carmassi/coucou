// What the Claude module knows of Claude Code sessions. Moved out of core/state.ts (m3-ok).

import type { BotStateName } from "../../core/layout";

import type { PillBadge } from "../../core/badge";
export type { PillBadge };

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** For an edit: what it would do to its file, to read before allowing it. */
  proposal: FileProposal | null;
  /** For the end of plan mode: the plan, to read before approving it. */
  plan: string | null;
}

/** An edit that has not happened yet, as the diff it would make. */
export interface FileProposal {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** The file does not exist yet. */
  created: boolean;
}

/** One thing Claude asks with its question tool, as the tool words it. */
export interface Question {
  question: string;
  /** A word or two saying what the question is about. */
  header: string | null;
  options: { label: string; description: string | null }[];
  multiSelect: boolean;
}

/** A question Claude is waiting on — up to four at once, answered together. */
export interface QuestionInfo {
  requestId: string;
  sessionId: string;
  questions: Question[];
}

/** The app a Claude Code session runs in. */
export type ClaudeClient = "desktop" | "vscode" | "terminal";

/** What the Claude pill is called while it follows a session from that app. */
export const CLIENT_NAMES: Record<ClaudeClient, string> = {
  desktop: "Claude",
  vscode: "VS Code",
  terminal: "Terminal",
};
/** Until a session has spoken, the pill keeps the name it always had. */
export const CLIENT_UNKNOWN = "VS Code";

/** One edit Claude made to a file: its unified diff, as coucou-hook built it. */
export interface FileEdit {
  patch: string;
  additions: number;
  deletions: number;
  /** The diff was longer than the relay forwards. */
  truncated: boolean;
  at: number;
}

/** A file Claude touched in a session, with every edit it made to it, oldest first. */
export interface ChangedFile {
  /** Relative to the session's folder when it is inside it, with forward slashes. */
  path: string;
  /** Written new in this session. */
  created: boolean;
  additions: number;
  deletions: number;
  edits: FileEdit[];
  at: number;
}

/** A few lines of what a tool gave back, as coucou-hook forwards them. */
export interface StepResult {
  text: string;
  /** For a file: the number of its first line. */
  start: number | null;
  /** There was more than this. */
  truncated: boolean;
  /** These are the last lines, not the first: what a command ended on. */
  tail: boolean;
}

/** The tool Claude asks its questions with. */
export const QUESTION_TOOL = "AskUserQuestion";
/** The tool Claude ends plan mode with: its approval card shows the plan. */
export const PLAN_TOOL = "ExitPlanMode";

/** The step that closes a turn, in the place of a tool's name. */
export const TURN_DONE = "Done";

/**
 * What a line of a session's journal is: a tool, by what it does as far as
 * showing it goes — or something said: what the user asked (`prompt`), what
 * Claude answered to end its turn (`reply`), a word from Claude Code (`note`).
 */
export type StepKind = "read" | "edit" | "command" | "search" | "other" | "prompt" | "reply" | "note";

/** The kinds of step that are words, not a tool at work. */
const SAID: ReadonlySet<StepKind> = new Set<StepKind>(["prompt", "reply", "note"]);

/**
 * One line of a session's journal, in the order things happened: a tool by
 * its own name — going, done, or failed — or something that was said.
 */
export interface SessionStep {
  tool: string;
  kind: StepKind;
  state: "running" | "done" | "failed";
  /**
   * What a tool is at: a file by its path in the session's folder, a command,
   * what is looked for. For something said: the words.
   */
  target: string | null;
  /** What it gave back, once it is done. */
  result: StepResult | null;
  /** For an edit: the diff it made. */
  patch: string | null;
  /** For Claude's question tool: what it asks, and once answered, what was picked for each. */
  questions: Question[] | null;
  answers: Record<string, string> | null;
  /** For a tool that had to ask first: where its permission request stands. */
  permission: "asked" | "allowed" | "denied" | null;
  /** When it started; once it has ended, when it ended. */
  at: number;
}

/** A step with nothing in it yet but what it is. */
export function newStep(tool: string, kind: StepKind, target: string | null): SessionStep {
  return {
    tool, kind, state: kind === "prompt" || kind === "reply" || kind === "note" ? "done" : "running",
    target, result: null, patch: null, questions: null, answers: null, permission: null, at: Date.now(),
  };
}

/** The tools of the turn under way: what the session did since it was last asked something. */
export function turnSteps(session: ClaudeSession): SessionStep[] {
  const asked = session.steps.map((step) => step.kind).lastIndexOf("prompt");
  return session.steps.slice(asked + 1).filter((step) => !SAID.has(step.kind));
}

/**
 * A Claude Code session the island knows of. There can be several at once —
 * two conversations in the Claude app, one more in a terminal — and one of
 * them is in front: the one the Claude pill, the cards and the panel show.
 */
export interface ClaudeSession {
  id: string;
  /** The Claude profile (normalised config dir key) it belongs to; "" = default. */
  profile: string;
  client: ClaudeClient | null;
  /** The conversation's title, when Claude Code has given it one. */
  title: string | null;
  /** The folder it works in: by its name, and whole. */
  project: string;
  cwd: string | null;
  state: BotStateName;
  /** What it did, a line per step, oldest first: what a card falls back on. */
  lines: string[];
  /** Its journal, oldest first: what was asked, each tool, what Claude said; "Done" closes a turn. */
  steps: SessionStep[];
  /** What the user asked last, and what Claude said to end its turn. */
  asked: string | null;
  answer: string | null;
  /** When that answer came. */
  answeredAt: number;
  /** What it is waiting on a human for: a permission, or a question. One at a time. */
  approval: ApprovalInfo | null;
  question: QuestionInfo | null;
  /** What happened here while another session was in front, until it is looked at. */
  news: PillBadge | null;
  /** When it was last heard from. */
  heardAt: number;
  /** The WSL distribution it runs in, when Claude Code runs under WSL. */
  wslDistro: string | null;
  /** The relay's ancestor processes; one of them owns the session's window. */
  terminalPids: number[];
  /** Subagents running now, and how many were launched in this wave. */
  agentsRunning: number;
  agentsLaunched: number;
  /** What the hooks say of how it runs: the model, the permission mode, the effort level. */
  model: string | null;
  mode: string | null;
  effort: string | null;
}

/** The permission modes Claude Code reports, as the user knows them. */
const MODE_NAMES: Record<string, string> = {
  default: "padrão", plan: "plano", acceptEdits: "aceitar edições", auto: "auto",
  bypassPermissions: "sem permissões", dontAsk: "não perguntar",
};
export const modeName = (mode: string): string => MODE_NAMES[mode] ?? mode;

/** "claude-opus-4-5-20251001" -> "Opus 4.5"; anything unrecognised is shown as it came. */
export function shortModel(model: string): string {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/i.exec(model);
  if (!m) return model;
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** What a session is called before its folder is known. */
export const SESSION_UNNAMED = "Sessão";

export function newSession(id: string): ClaudeSession {
  return {
    id, profile: "", client: null, title: null, project: SESSION_UNNAMED, cwd: null, state: "idle",
    lines: [], steps: [], asked: null, answer: null, answeredAt: 0,
    approval: null, question: null, news: null, heardAt: 0, wslDistro: null, terminalPids: [],
    agentsRunning: 0, agentsLaunched: 0, model: null, mode: null, effort: null,
  };
}

/** The pill that follows Claude Code sessions. */
export const CLAUDE_ID = "integration_claude";
/** Same colour the pill had as an integration. */
export const CLAUDE_COLOR = "#F5F6F8";
