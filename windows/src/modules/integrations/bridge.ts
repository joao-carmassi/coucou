import { command, commandOrThrow } from "../../kit/tauri";


export const IntegrationsBridge = {
  /** Only ever tells you whether a key exists, never its value. */
  secretPresent: (key: string) => command<boolean>("integrations_secret_present", { key }),
  secretSet: (key: string, value: string) => commandOrThrow<void>("integrations_secret_set", { key, value }),
  secretClear: (key: string) => commandOrThrow<void>("integrations_secret_clear", { key }),
  refreshIntegration: (id: string) => command<void>("integrations_refresh", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => command<void>("n8n_open"),
  /** Settings: runs on the stored token; the token never comes back. */
  githubTest: () => commandOrThrow<GithubAccount>("github_test"),
  /** A project sheet, fetched on the click. `force` skips the minute of cache. */
  githubProject: (fullName: string, force: boolean) => commandOrThrow<GithubProject>("github_project", { fullName, force }),
  /** What was done on one day of the graph, between two local midnights (ISO). */
  githubDay: (from: string, to: string, today: boolean) => commandOrThrow<GithubDay>("github_day", { from, to, today }),
  /** The sheet behind a line of activity. `target` goes back exactly as Rust sent it. */
  githubDetail: (target: GithubTarget, force: boolean) => commandOrThrow<GithubDetail>("github_detail", { target, force }),
};


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

