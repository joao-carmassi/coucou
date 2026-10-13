// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function command<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  /** Which modules are on (resolved by Rust). */
  modules: Record<string, boolean>;
}

export const Bridge = {
  boot: () => command<BootInfo>("boot"),

  saveSettings: (settings: Settings) => command<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => command<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    command<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus and take it away again. */
  focusWindow: (focused: boolean) => command<void>("focus_window", { focused }),

  reposition: () => command<void>("reposition"),

  openUrl: (url: string) => command<void>("open_url", { url }),

  quit: () => command<void>("quit_app"),

  openSettingsWindow: () => command<void>("open_settings_window"),

  /** The section the settings window was opened for, once ("" for none). */
  takeSettingsSection: () => command<string>("take_settings_section"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => command<void>("log_line", { message }),

  /** Tray → Pause. */
  setPaused: (paused: boolean) => command<void>("set_paused", { paused }),

  // ── Claude module (claude): hooks, sessions, approvals, WSL ───────────────
  openInVSCode: (path: string | null, wslDistro: string | null = null) =>
    command<boolean>("open_in_vscode", { path, wslDistro }),
  openClaudeApp: () => command<void>("open_claude_app"),
  openTerminal: (path: string | null, wslDistro: string | null, terminalPids: number[]) =>
    command<boolean>("open_terminal", { path, wslDistro, terminalPids }),
  startClaudeTerminal: () => command<boolean>("start_claude_terminal"),
  hooksStatus: (configDir?: string) => command<HookStatus>("hooks_status", { configDir }),
  hooksPreview: (install: boolean, configDir?: string) =>
    commandOrThrow<HookPreview>("hooks_preview", { install, configDir }),
  hooksApply: (install: boolean, fingerprint: string, configDir?: string) =>
    commandOrThrow<string>("hooks_apply", { install, fingerprint, configDir }),
  claudeProfiles: () => command<ClaudeProfile[]>("claude_profiles"),
  sessionsAll: () => command<ManagedSession[]>("sessions_all"),
  sessionsLive: () => command<LiveSession[]>("sessions_live"),
  sessionLaunch: (r: LaunchRequest) =>
    commandOrThrow<void>("session_launch", { profile: r.profile, cwd: r.cwd, resume: r.resume, attach: r.attach, prompt: r.prompt ?? null }),
  sessionErase: (profile: string, id: string) => commandOrThrow<void>("session_erase", { profile, id }),
  wslDistros: () => command<string[]>("wsl_distros"),
  wslStatus: (distro: string) => commandOrThrow<WslStatus>("wsl_status", { distro }),
  wslHooksPreview: (distro: string, install: boolean) =>
    commandOrThrow<HookPreview>("wsl_hooks_preview", { distro, install }),
  wslHooksApply: (distro: string, install: boolean, fingerprint: string) =>
    commandOrThrow<string>("wsl_hooks_apply", { distro, install, fingerprint }),
  approvalDecision: (requestId: string, decision: "allow" | "deny" | "skip" | "plan-keep" | "plan-manual" | "plan-auto") =>
    command<void>("approval_decision", { requestId, decision }),
  approvalAck: (requestId: string) => command<void>("approval_ack", { requestId }),
  approvalDecline: (requestId: string) => command<void>("approval_decline", { requestId }),
  approvalAnswer: (requestId: string, answers: Record<string, string>) =>
    command<void>("approval_answer", { requestId, answers }),
  resumeInTerminal: (id: string, cwd: string | null) =>
    commandOrThrow<void>("resume_in_terminal", { id, cwd }),
  /** Copies a file into the inbox (the only place a session may attach from). */
  ingestClaudeFile: (path: string) => commandOrThrow<ClaudeInboxFile>("ingest_file", { path }),

  // ── Voice module (voice) ──────────────────────────────────────────────────
  voiceStart: () => commandOrThrow<void>("voice_start"),
  voiceStop: () => command<void>("voice_stop"),
  voiceModelStatus: () => command<VoiceStatus>("voice_model_status"),
  voiceDownloadModel: () => commandOrThrow<void>("voice_download_model"),
  // ── Integrations module (integrations): secrets, pollers, GitHub panel ────
  /** Only ever tells you whether a key exists, never its value. */
  secretPresent: (key: string) => command<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => commandOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => commandOrThrow<void>("secret_clear", { key }),
  refreshIntegration: (id: string) => command<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => command<void>("open_n8n"),
  /** Settings: runs on the stored token; the token never comes back. */
  githubTest: () => commandOrThrow<GithubAccount>("github_test"),
  /** A project sheet, fetched on the click. `force` skips the minute of cache. */
  githubProject: (fullName: string, force: boolean) => commandOrThrow<GithubProject>("github_project", { fullName, force }),
  /** What was done on one day of the graph, between two local midnights (ISO). */
  githubDay: (from: string, to: string, today: boolean) => commandOrThrow<GithubDay>("github_day", { from, to, today }),
  /** The sheet behind a line of activity. `target` goes back exactly as Rust sent it. */
  githubDetail: (target: GithubTarget, force: boolean) => commandOrThrow<GithubDetail>("github_detail", { target, force }),
};

// ── Media module ─────────────────────────────────────────────────────────────

export const MediaBridge = {
  /** Screenshots the window under the cursor into the inbox (Mochi dragged onto it). */
  attachWindow: () => commandOrThrow<ClaudeInboxFile>("attach_window"),
  list: () => commandOrThrow<MediaItem[]>("media_list"),
  /** The file's preview as PNG bytes. */
  thumb: (path: string, px: number) => commandOrThrow<ArrayBuffer>("media_thumb", { path, px }),
  open: (path: string) => commandOrThrow<void>("media_open", { path }),
  openWith: (path: string) => commandOrThrow<void>("media_open_with", { path }),
  reveal: (path: string) => commandOrThrow<void>("media_reveal", { path }),
  /** Off the list only; the file stays on disk. */
  remove: (path: string) => commandOrThrow<void>("media_remove", { path }),
};

export interface MediaItem {
  path: string;
  name: string;
  /** "screenshot", "video" or "file". */
  kind: string;
  /** Unix ms. */
  ts: number;
  size: number;
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  /** `end`: the drag finished without a drop on the island. */
  type: "enter" | "over" | "drop" | "leave" | "end";
  paths?: string[];
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 * Comes from Coucou's own drop target (drop_target.rs), not Tauri's: WebView2
 * replaces the one wry installs with a target that refuses every file.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

// ── Claude module types (shapes of the Rust commands at m3-ok) ──────────────

/** Same as `command`, but surfaces the error so the UI can show what went wrong. */
async function commandOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export interface ClaudeInboxFile { name: string; path: string; size: number }

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
  /** Claude Code on Windows, if installed. */
  claudeCli: string | null;
}

export interface WslStatus {
  distro: string;
  installed: boolean;
  /** Linux paths, as the user knows them. */
  settingsPath: string;
  relayPath: string;
  relayReady: boolean;
  /** Claude Code inside the distro, if installed. */
  claudeCli: string | null;
  /** The distro could not be reached; nothing else is meaningful then. */
  error: string | null;
}

export interface ClaudeProfile { key: string; label: string; configDir: string; isDefault: boolean }

export interface ManagedSession {
  id: string; cwd: string; title: string; updated: number; profile: string;
  status: "running" | "offline"; activity: string | null; pid: number | null;
}

export interface LiveSession { profile: string; id: string; pid: number; activity: string | null }

export interface LaunchRequest { profile: string; cwd: string | null; resume: string | null; attach: string | null; prompt?: string | null }

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

export interface VoiceStatus { ready: boolean; listening: boolean; hotkeyError: string }
// ── Integrations module types (shapes of the Rust commands at m3-ok) ────────

/** What a line of activity leads to — the Target enum in github_detail.rs. */
export type GithubTarget =
  | { kind: "pull"; repo: string; number: number }
  | { kind: "issue"; repo: string; number: number }
  | {
      kind: "commits"; repo: string; head: string | null; count: number | null;
      branch: string | null; author: string | null; from: string | null; to: string | null;
    }
  | { kind: "release"; repo: string; tag: string }
  | { kind: "project"; repo: string }
  | { kind: "run"; repo: string; id: number }
  | { kind: "comments"; repo: string; number: number };

export interface GithubFile {
  path: string;
  /** added, modified, removed, renamed… */
  status: string | null;
  additions: number;
  deletions: number;
  /** The unified diff; null for a binary file or one GitHub won't diff. */
  patch: string | null;
  /** The patch was cut short; the rest is on GitHub. */
  truncated: boolean;
}

export interface GithubLabel {
  name: string;
  /** "#rrggbb". */
  color: string;
}

export interface GithubPullDetail {
  kind: "pull";
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  author: string | null;
  base: string | null;
  head: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  /** Threads of comments on the lines of code. */
  threads: number;
  review: "approved" | "changes requested" | "review required" | null;
  reviewers: { login: string; state: "approved" | "changes requested" | "commented" | "dismissed" }[];
  labels: GithubLabel[];
  files: GithubFile[];
  createdAt: string | null;
  mergedAt: string | null;
  mergedBy: string | null;
  closedAt: string | null;
  ci: GithubBuild | null;
  missing: string[];
}

export interface GithubIssueDetail {
  kind: "issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "completed" | "not planned" | "closed";
  author: string | null;
  body: string | null;
  labels: GithubLabel[];
  assignees: string[];
  comments: number;
  createdAt: string | null;
  closedAt: string | null;
}

export interface GithubCommitsDetail {
  kind: "commits";
  repo: string;
  branch: string | null;
  /** How many the push or the day counted; `commits` may hold fewer. */
  total: number | null;
  /** Newest first. */
  commits: { sha: string; id: string; message: string; author: string | null; at: string | null; url: string }[];
  /** What the newest commit changed. */
  additions: number | null;
  deletions: number | null;
  files: GithubFile[];
  ci: GithubBuild | null;
  url: string;
  missing: string[];
}

export interface GithubReleaseDetail {
  kind: "release";
  repo: string;
  tag: string;
  name: string;
  url: string;
  body: string | null;
  author: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  assets: { name: string; downloads: number; size: number }[];
  downloads: number;
}

/**
 * A step of a job, a job of a run, a run: its colour (`state`), its word
 * (`outcome`: passed, failed, running, queued, cancelled, skipped…), and when
 * it started and ended — how long it took is worked out from those.
 */
export interface GithubTimed {
  state: GithubBuild["state"];
  outcome: string;
  /** Null while it waits for its turn. */
  startedAt: string | null;
  /** Null while it runs. */
  endedAt: string | null;
}

export interface GithubStep extends GithubTimed {
  name: string;
}

export interface GithubJob extends GithubTimed {
  id: number;
  name: string;
  /** The job's page on GitHub, with its logs. */
  url: string;
  /** The machine it asked for, e.g. "ubuntu-latest". */
  runner: string | null;
  steps: GithubStep[];
}

export interface GithubRunDetail extends GithubTimed {
  kind: "run";
  repo: string;
  id: number;
  workflow: string;
  title: string | null;
  branch: string | null;
  /** push, pull_request, schedule, workflow_dispatch… */
  event: string | null;
  actor: string | null;
  /** 2 and up for a re-run. */
  attempt: number;
  url: string;
  jobs: GithubJob[];
  /** Jobs of the run beyond the ones carried. */
  moreJobs: number;
}

/** Something somebody wrote on a pull request. */
export interface GithubRemark {
  /** Null for an account that is gone. */
  author: string | null;
  /** Plain text, its lines kept; empty for a review that only gave a verdict. */
  body: string;
  /** The text was cut short; the whole of it is at `url`. */
  cut: boolean;
  at: string | null;
  url: string;
}

/** Comments on one place in the code, and the replies under them. */
export interface GithubThread {
  path: string;
  /** Null on a whole file, or once the code under it has changed. */
  line: number | null;
  /** "left" on a line that was removed. */
  side: "left" | "right";
  resolved: boolean;
  outdated: boolean;
  /** The lines it is about, numbered as in the file. */
  code: { number: number | null; sign: "+" | "-" | ""; text: string }[];
  remarks: GithubRemark[];
  /** Replies beyond the ones carried. */
  more: number;
}

export type GithubEntry =
  | ({ kind: "description" | "comment" } & GithubRemark)
  | ({ kind: "review"; state: "approved" | "changes requested" | "commented" | "dismissed" } & GithubRemark)
  | ({ kind: "thread" } & GithubThread);

/** What was said on a pull request, oldest first. To read only. */
export interface GithubCommentsDetail {
  kind: "comments";
  repo: string;
  number: number;
  title: string;
  url: string;
  entries: GithubEntry[];
  /** Older ones than these are on GitHub. */
  earlier: boolean;
}

/** A line's sheet, or the permission the token lacks to read it. */
export type GithubDetail =
  | GithubPullDetail
  | GithubIssueDetail
  | GithubCommitsDetail
  | GithubReleaseDetail
  | GithubRunDetail
  | GithubCommentsDetail
  | { kind: "locked"; permission: string };

/** A clicked day of the contribution graph — the Day struct in github.rs. */
export interface GithubDay {
  items: {
    kind: GithubActivityKind | "review";
    /** "owner/name". */
    repo: string;
    title: string;
    detail: string | null;
    url: string;
    target: GithubTarget | null;
  }[];
  /** Contributions that day in repositories the token can't see into. */
  privateCount: number;
}

/** The sheet behind a click on a project — the Project struct in github.rs. */
export interface GithubProject {
  fullName: string;
  url: string;
  description: string | null;
  homepage: string | null;
  private: boolean;
  createdAt: string | null;
  stars: number;
  forks: number;
  /** Largest first, the tail folded into "Other" (color null). */
  languages: { name: string; color: string | null; share: number }[];
  /** Newest first, up to eight — the CI streak. */
  runs: GithubRun[];
  pull: GithubPull | null;
  deploy: GithubDeploy | null;
  /** The permissions the token lacks to read some of this, as GitHub names them. */
  missing: string[];
}

export interface GithubRun {
  id: number;
  state: GithubBuild["state"];
  workflow: string;
  branch: string | null;
  /** The commit or pull request the run is about. */
  title: string | null;
  actor: string | null;
  url: string;
  startedAt: string | null;
  updatedAt: string;
}

export interface GithubPull {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  author: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  review: "approved" | "changes requested" | "review required" | null;
  comments: number;
  /** Merged at, or last update. */
  at: string;
}

export interface GithubDeploy {
  environment: string;
  state: "success" | "failure" | "running" | "inactive";
  url: string | null;
  creator: string | null;
  sha: string | null;
  at: string;
}

/** `State.integrations.integration_github.data` — the Snapshot in github.rs. */
export interface GithubData {
  login: string;
  profileUrl: string;
  totalStars: number;
  /** Newest first. */
  activity: GithubActivity[];
  /** Most recently pushed first. */
  repos: GithubRepo[];
  /** The year behind the contribution graph. */
  contributions: GithubContributions | null;
  /** Unix ms of the last complete refresh. */
  fetchedAt: number;
}

export interface GithubContributions {
  total: number;
  /** First day, "YYYY-MM-DD"; one entry per day from there, today last. */
  start: string;
  counts: number[];
  /** GitHub's quartiles: 0 (none) to 4 (busiest). */
  levels: number[];
}

export interface GithubRepo {
  /** "owner/name". */
  fullName: string;
  url: string;
  private: boolean;
  language: string | null;
  /** GitHub's colour for the language. */
  languageColor: string | null;
  stars: number;
  openPrs: number;
  /** ISO 8601. */
  pushedAt: string | null;
  /** The newest Actions run on any branch; null when there is none to read. */
  build: GithubBuild | null;
}

export interface GithubBuild {
  id: number;
  state: "success" | "failure" | "running" | "neutral";
  /** The workflow's name, e.g. "CI". */
  workflow: string;
  branch: string | null;
  url: string;
  /** ISO 8601. */
  at: string;
}

export type GithubActivityKind =
  | "push" | "pr_opened" | "pr_merged" | "pr_closed"
  | "issue_opened" | "issue_closed" | "release" | "create";

export interface GithubActivity {
  kind: GithubActivityKind;
  /** "owner/name". */
  repo: string;
  title: string;
  /** "#12", a branch, a tag. */
  detail: string | null;
  url: string;
  /** ISO 8601. */
  at: string;
  /** The sheet a click opens in the panel; null: straight to GitHub. */
  target: GithubTarget | null;
}

export interface GithubAccount {
  login: string;
  name: string | null;
  /** GitHub's `github-authentication-token-expiration` header, as sent. Null: no expiry. */
  expiresAt: string | null;
  /** One line per thing the panel needs, so a missing permission is named. */
  checks: { label: string; ok: boolean; note: string | null }[];
}

/**
 * One thing a news card says under its title, with what it is, so it is drawn
 * as that: a project, who did it (`verb`: "merged by"), a size in lines, a
 * count of files, a branch, the step a build broke at, a commit's title.
 */
export interface NewsFact {
  kind: "repo" | "by" | "diff" | "files" | "branch" | "step" | "commit";
  text?: string;
  verb?: string;
  additions?: number;
  deletions?: number;
}

/** Something that just happened in an integration: the pill's badge and sound. */
export interface IntegrationNews {
  success: boolean;
  label: string;
  detail: string | null;
  /**
   * What the island can say and open for it (GitHub): a title and a line of
   * facts for the card — the step that broke, who merged — and the run or
   * the pull request to go to.
   */
  open?: {
    target?: GithubTarget; label?: string; url?: string; title?: string; facts?: NewsFact[];
    /** What kind of news this is, as the card says it: "pull request opened". */
    says?: string;
  };
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: IntegrationNews | null;
}
