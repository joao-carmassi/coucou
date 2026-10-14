// Markup safety net: outerHTML of module-built DOM from fixed fixtures, kept as file snapshots in
// __markup__/. The kit refactor must leave every one byte-identical. Time is frozen, TZ is UTC.
process.env.TZ = "UTC";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const T = vi.hoisted(() => ({
  hosts: {} as Record<string, import("../../src/core/moduleApi").ViewHost>,
  apis: {} as Record<string, import("../../src/core/moduleApi").IslandApi>,
  claude: null as unknown,
  handlers: {} as Record<string, ((p: { payload: unknown }) => void)[]>,
  answers: {} as Record<string, (args: any) => unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    if (T.answers[cmd]) return T.answers[cmd](args);
    return cmd === "integrations_secret_present" ? true : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (p: { payload: unknown }) => void) => ((T.handlers[name] ??= []).push(fn), () => {}),
}));
// Every real module, its views and apis captured on the way (no production seam needed).
vi.mock("../../src/modules/index", async (orig) => {
  const real = await orig<typeof import("../../src/modules/index")>();
  return {
    MODULES: real.MODULES.map((m) => ({
      ...m,
      views: m.views?.map((v) => ({ ...v, build: (ctx: any) => ((T.hosts[v.name] = v.build(ctx)), T.hosts[v.name]) })),
      start: (api: any) => ((T.apis[m.id] = api), m.start(api)),
    })),
  };
});
vi.mock("../../src/modules/claude/claude", async (orig) => {
  const real = await orig<typeof import("../../src/modules/claude/claude")>();
  return { ...real, claudeOf: (api: any) => ((T.claude = real.claudeOf(api)), T.claude) };
});

// The timer reads Date.now through a reference taken at import, before time is frozen: read it late.
vi.mock("../../src/modules/timer/timer", async (orig) => {
  const real = await orig<typeof import("../../src/modules/timer/timer")>();
  return { ...real, TimerClock: class extends real.TimerClock { constructor() { super(() => Date.now()); } } };
});
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { MODULES } from "../../src/modules/index";
import { info, steps, PROVIDERS } from "../../src/modules/integrations/store";
import { renderIntegrationCard, type IntegrationCardHooks } from "../../src/modules/integrations/views/integrations";
import { enterGithubPanel } from "../../src/modules/integrations/views/github";
import type { Pill } from "../../src/core/moduleApi";
import { Up } from "../../src/modules/upload/state";
import { Voice } from "../../src/modules/voice/view";
import { enterSessionPanel } from "../../src/modules/claude/views/session";
import { newSession, newStep, type SessionStep } from "../../src/modules/claude/types";

const NOW = new Date("2026-03-10T12:00:00Z");
let island: Island;
const flush = async () => { for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(10); } vi.setSystemTime(NOW); };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island);
  Registry.apply(Object.fromEntries(MODULES.map((m) => [m.id, true])));
  island.launch();
  await flush();
});
afterAll(() => vi.useRealTimers());

/** One snapshot per name; tags go on their own lines so a diff reads, nothing else is touched. */
const snap = (name: string, el: Element) => expect(el.outerHTML.replace(/></g, ">\n<") + "\n").toMatchFileSnapshot(`__markup__/${name}.html`);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const lookup = (id: string) => PROVIDERS.find((p) => p.id === id)!;

// ── Integrations cards ──────────────────────────────────────────────────────────────────────

const hooks = (detailOpen = false): IntegrationCardHooks => ({ detailOpen, openDetail() {}, closeDetail() {}, openSettings() {}, openPanel() {} });
function cardOf(id: string, st: { configured?: boolean; loaded?: boolean; error?: string | null; data?: Record<string, unknown>; mood?: Pill["mood"]; lines?: string[]; detail?: boolean }) {
  const p = lookup(id);
  info[id] = { data: st.data ?? {}, error: st.error ?? null, loaded: st.loaded ?? false, configured: st.configured ?? true };
  steps.set(id, st.lines ?? []);
  const pill: Pill = { id, label: p.name, color: p.color, mood: st.mood ?? "idle" };
  return renderIntegrationCard(pill, hooks(st.detail));
}

const DATA: Record<string, Record<string, unknown>> = {
  integration_vercel: { deployments: [
    { projectName: "coucou-site", state: "READY", createdAt: ago(5 * MIN), commitMessage: "fix: header spacing", branch: "main", url: "coucou-site.vercel.app" },
    { projectName: "api", state: "ERROR", createdAt: ago(3 * HOUR) },
    { projectName: "docs", state: "READY", createdAt: ago(2 * DAY) },
    { projectName: "hidden-fourth", state: "READY", createdAt: ago(9 * DAY) },
  ] },
  integration_stripe: { balance: 123456, currency: "eur", payments: [
    { description: "Plano Pro", amount: 4900, status: "succeeded", createdAt: ago(20 * MIN) },
    { description: null, amount: 1500, status: "failed", createdAt: ago(5 * HOUR) },
  ] },
  integration_resend: { total: 128, emails: [
    { to: ["ana@example.com"], subject: "Bem-vinda", lastEvent: "delivered", createdAt: ago(2 * MIN) },
    { to: ["bob@example.com"], subject: "Recibo", lastEvent: "bounced", createdAt: ago(1 * HOUR) },
    { to: [], lastEvent: "delivered", createdAt: ago(30 * HOUR) },
  ] },
  integration_notion: { pages: [
    { title: "Roadmap", emoji: "🗺", lastEditedAt: ago(10 * MIN), url: "https://notion.so/a" },
    { title: null, lastEditedAt: ago(4 * HOUR), url: "https://notion.so/b" },
  ] },
  integration_calcom: { bookings: [
    { title: "Call de produto", start: "2026-03-12T15:30:00Z" },
    { title: "Reunião", start: "2026-03-11T09:00:00Z" },
  ] },
};

describe("integrations cards", () => {
  for (const p of PROVIDERS.filter((x) => x.id !== "integration_github")) {
    const name = p.id.replace("integration_", "");
    it(`${name} not configured`, () => snap(`integrations-${name}-unconfigured`, cardOf(p.id, { configured: false })));
    it(`${name} configured without data`, () => snap(`integrations-${name}-nodata`, cardOf(p.id, { configured: true })));
    it(`${name} error`, () => snap(`integrations-${name}-error`, cardOf(p.id, { configured: true, error: "401 unauthorized" })));
    if (DATA[p.id]) it(`${name} with data`, () => snap(`integrations-${name}-data`, cardOf(p.id, { loaded: true, data: DATA[p.id] })));
  }
  it("stripe loaded but empty", () => snap("integrations-stripe-empty", cardOf("integration_stripe", { loaded: true, data: { balance: 0, currency: "usd", payments: [] } })));
  it("calcom loaded but empty", () => snap("integrations-calcom-empty", cardOf("integration_calcom", { loaded: true, data: { bookings: [] } })));
  it("vercel detail ready", () => snap("integrations-vercel-detail", cardOf("integration_vercel", { loaded: true, data: DATA.integration_vercel, detail: true })));
  it("vercel detail failed", () => snap("integrations-vercel-detail-error", cardOf("integration_vercel", { loaded: true, detail: true, data: { deployments: [{ projectName: "api", state: "CANCELED", createdAt: ago(3 * HOUR) }] } })));
  it("n8n activity success", () => snap("integrations-n8n-done", cardOf("integration_n8n", { mood: "done", lines: ["Backup nightly", "42 items\nall good"] })));
  it("n8n activity failed", () => snap("integrations-n8n-failed", cardOf("integration_n8n", { mood: "error", lines: ["Sync CRM"] })));
  it("n8n detail success", () => snap("integrations-n8n-detail-done", cardOf("integration_n8n", { mood: "done", lines: ["Backup nightly", "42 items\nall good"], detail: true })));
  it("n8n detail failed no text", () => snap("integrations-n8n-detail-failed", cardOf("integration_n8n", { mood: "error", lines: ["Sync CRM"], detail: true })));
  it("n8n detail success no text", () => snap("integrations-n8n-detail-done-bare", cardOf("integration_n8n", { mood: "done", lines: ["Ping"], detail: true })));
});

// ── GitHub panel ────────────────────────────────────────────────────────────────────────────

const PATCH = "@@ -1,4 +1,5 @@\n import a from \"a\";\n-const x = 1;\n+const x = 2;\n+const y = 3;\n export { x };\n@@ -20,3 +21,3 @@\n context\n-old line\n+new line";
const FILES = [
  { path: "src/app/main.ts", status: "modified", additions: 12, deletions: 3, patch: PATCH, truncated: false },
  { path: "README.md", status: "added", additions: 5, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+# Title\n+text", truncated: false },
  { path: "assets/logo.png", status: "removed", additions: 0, deletions: 0, patch: null, truncated: false },
  { path: "package-lock.json", status: "modified", additions: 400, deletions: 20, patch: "@@ -1 +1 @@\n-a\n+b", truncated: true },
];
const BUILD = (state: string, id = 900) => ({ id, state, workflow: "CI", branch: "main", url: "https://github.com/mochi-dev/coucou/actions/runs/" + id, at: ago(12 * MIN) });
const T0 = (state: string, outcome: string, start: number | null, end: number | null) => ({ state, outcome, startedAt: start == null ? null : ago(start), endedAt: end == null ? null : ago(end) });
const RUN = {
  kind: "run", repo: "mochi-dev/coucou", id: 900, ...T0("failure", "failed", 14 * MIN, 9 * MIN), workflow: "CI", title: "feat: crew", branch: "main",
  event: "push", actor: "mochi-dev", attempt: 2, url: "https://github.com/mochi-dev/coucou/actions/runs/900", moreJobs: 1,
  jobs: [
    { id: 1, name: "build", url: "u1", runner: "ubuntu-latest", ...T0("success", "passed", 14 * MIN, 11 * MIN), steps: [
      { name: "Checkout", ...T0("success", "passed", 14 * MIN, 13 * MIN) }, { name: "Install", ...T0("success", "passed", 13 * MIN, 12 * MIN) }] },
    { id: 2, name: "test", url: "u2", runner: "ubuntu-latest", ...T0("failure", "failed", 14 * MIN, 9 * MIN), steps: [
      { name: "Checkout", ...T0("success", "passed", 14 * MIN, 13 * MIN) }, { name: "Run tests", ...T0("failure", "failed", 13 * MIN, 9 * MIN) },
      { name: "Upload", ...T0("neutral", "skipped", null, null) }] },
    { id: 3, name: "lint", url: "u3", runner: null, ...T0("neutral", "queued", null, null), steps: [] },
  ],
};
const DETAILS: Record<string, unknown> = {
  pull: {
    kind: "pull", repo: "mochi-dev/coucou", number: 12, title: "Add the crew", url: "https://github.com/mochi-dev/coucou/pull/12", state: "open",
    author: "ana", base: "main", head: "crew", additions: 417, deletions: 23, changedFiles: 4, commits: 3, comments: 2, threads: 1, review: "changes requested",
    reviewers: [{ login: "bob", state: "changes requested" }, { login: "cy", state: "approved" }], labels: [{ name: "ui", color: "#a2eeef" }],
    files: FILES, createdAt: ago(2 * DAY), mergedAt: null, mergedBy: null, closedAt: null, ci: BUILD("failure"), missing: ["pull_requests"],
  },
  issue: {
    kind: "issue", repo: "mochi-dev/coucou", number: 7, title: "Crash on start", url: "https://github.com/mochi-dev/coucou/issues/7", state: "open",
    author: "ana", body: "It crashes.\nSecond line.", labels: [{ name: "bug", color: "#d73a4a" }], assignees: ["bob"], comments: 3, createdAt: ago(3 * DAY), closedAt: null,
  },
  commits: {
    kind: "commits", repo: "mochi-dev/coucou", branch: "main", total: 3, url: "https://github.com/mochi-dev/coucou/compare/a...b",
    commits: [
      { sha: "abc1234", id: "abc1234def", message: "feat: crew\n\nbody text", author: "mochi-dev", at: ago(20 * MIN), url: "u" },
      { sha: "def5678", id: "def5678abc", message: "fix: typo", author: "ana", at: ago(2 * HOUR), url: "u" },
    ],
    additions: 17, deletions: 3, files: FILES.slice(0, 2), ci: BUILD("success"), missing: [],
  },
  release: {
    kind: "release", repo: "mochi-dev/coucou", tag: "v0.6.1", name: "Coucou 0.6.1", url: "https://github.com/mochi-dev/coucou/releases/tag/v0.6.1",
    body: "## Changes\n- one\n- two", author: "mochi-dev", publishedAt: ago(DAY), prerelease: false,
    assets: [{ name: "coucou.msi", downloads: 1200, size: 5_242_880 }, { name: "coucou.zip", downloads: 3, size: 2048 }], downloads: 1203,
  },
  run: RUN,
  comments: {
    kind: "comments", repo: "mochi-dev/coucou", number: 12, title: "Add the crew", url: "https://github.com/mochi-dev/coucou/pull/12", earlier: true,
    entries: [
      { kind: "description", author: "ana", body: "Adds the crew.", cut: false, at: ago(2 * DAY), url: "u" },
      { kind: "review", state: "changes requested", author: "bob", body: "Please split.", cut: true, at: ago(DAY), url: "u" },
      { kind: "comment", author: null, body: "ok", cut: false, at: ago(HOUR), url: "u" },
      { kind: "thread", path: "src/app/main.ts", line: 2, side: "right", resolved: false, outdated: false, more: 1,
        code: [{ number: 1, sign: "", text: "import a" }, { number: 2, sign: "+", text: "const x = 2;" }],
        remarks: [{ author: "bob", body: "why 2?", cut: false, at: ago(HOUR), url: "u" }, { author: "ana", body: "because", cut: false, at: ago(30 * MIN), url: "u" }] },
      { kind: "thread", path: "gone.ts", line: null, side: "left", resolved: true, outdated: true, more: 0, code: [],
        remarks: [{ author: "cy", body: "nit", cut: false, at: ago(HOUR), url: "u" }] },
    ],
  },
  locked: { kind: "locked", permission: "actions" },
};
const PROJECT = {
  fullName: "mochi-dev/coucou", url: "https://github.com/mochi-dev/coucou", description: "A friendly island", homepage: "https://coucou.example", private: false,
  createdAt: ago(300 * DAY), stars: 1284, forks: 31,
  languages: [{ name: "TypeScript", color: "#3178c6", share: 0.7 }, { name: "Rust", color: "#dea584", share: 0.25 }, { name: "Other", color: null, share: 0.05 }],
  runs: [{ id: 900, state: "failure", workflow: "CI", branch: "main", title: "feat: crew", actor: "mochi-dev", url: "u", startedAt: ago(14 * MIN), updatedAt: ago(9 * MIN) },
    { id: 899, state: "success", workflow: "CI", branch: "main", title: null, actor: null, url: "u", startedAt: null, updatedAt: ago(5 * HOUR) },
    { id: 898, state: "running", workflow: "Release", branch: null, title: "tag", actor: "ana", url: "u", startedAt: ago(MIN), updatedAt: ago(MIN) }],
  pull: { number: 12, title: "Add the crew", url: "u", state: "open", author: "ana", additions: 417, deletions: 23, changedFiles: 4, review: "approved", comments: 2, at: ago(HOUR) },
  deploy: { environment: "production", state: "success", url: "https://coucou.example", creator: "mochi-dev", sha: "abc1234", at: ago(2 * HOUR) },
  missing: [],
};
const DAYS = { items: [
  { kind: "push", repo: "mochi-dev/coucou", title: "3 commits", detail: "main", url: "u", target: { kind: "commits", repo: "mochi-dev/coucou", head: "abc", count: 3, branch: "main", author: "mochi-dev", from: null, to: null } },
  { kind: "pr_opened", repo: "ana/other", title: "Add the crew", detail: "#12", url: "u", target: { kind: "pull", repo: "ana/other", number: 12 } },
  { kind: "review", repo: "mochi-dev/coucou", title: "Review", detail: null, url: "u", target: null },
], privateCount: 4 };
const ACT = (kind: string, repo: string, title: string, detail: string | null, at: number, target: unknown) => ({ kind, repo, title, detail, url: "u", at: ago(at), target });
const dead = (i: number) => (i * 7) % 11 % 5 === 0;
const CONTRIB = { total: 1234, start: "2025-11-11", counts: Array.from({ length: 120 }, (_, i) => (dead(i) ? 0 : (i * 3) % 9 + 1)), levels: Array.from({ length: 120 }, (_, i) => (dead(i) ? 0 : 1 + ((i * 3) % 9) % 4)) };
const GH = {
  login: "mochi-dev", profileUrl: "https://github.com/mochi-dev", totalStars: 1284, fetchedAt: NOW.getTime(), contributions: CONTRIB,
  activity: [
    ACT("pr_merged", "mochi-dev/coucou", "Add the crew", "#12 · merged", 5 * MIN, { kind: "pull", repo: "mochi-dev/coucou", number: 12 }),
    ACT("push", "mochi-dev/coucou", "3 commits", "main", 40 * MIN, { kind: "commits", repo: "mochi-dev/coucou", head: "abc", count: 3, branch: "main", author: null, from: null, to: null }),
    ACT("release", "ana/other", "Coucou 0.6.1", "v0.6.1", 3 * HOUR, { kind: "release", repo: "ana/other", tag: "v0.6.1" }),
    ACT("issue_opened", "mochi-dev/coucou", "Crash on start", "#7", 20 * HOUR, { kind: "issue", repo: "mochi-dev/coucou", number: 7 }),
    ACT("create", "mochi-dev/new", "new", null, 2 * DAY, { kind: "project", repo: "mochi-dev/new" }),
    ACT("issue_closed", "mochi-dev/coucou", "Old", "#1", 3 * DAY, null),
  ],
  repos: [
    { fullName: "mochi-dev/coucou", url: "https://github.com/mochi-dev/coucou", private: false, language: "TypeScript", languageColor: "#3178c6", stars: 1284, openPrs: 2, pushedAt: ago(5 * MIN), build: BUILD("failure") },
    { fullName: "mochi-dev/secret", url: "https://github.com/mochi-dev/secret", private: true, language: "Rust", languageColor: "#dea584", stars: 0, openPrs: 0, pushedAt: ago(2 * DAY), build: BUILD("running", 901) },
    { fullName: "ana/other", url: "https://github.com/ana/other", private: false, language: null, languageColor: null, stars: 12, openPrs: 0, pushedAt: null, build: null },
    { fullName: "mochi-dev/ok", url: "https://github.com/mochi-dev/ok", private: false, language: "Go", languageColor: null, stars: 3, openPrs: 1, pushedAt: ago(9 * DAY), build: BUILD("success", 902) },
  ],
};

const feed = (id: string, data: Record<string, unknown>, error: string | null = null, event: unknown = null) => T.handlers["integration"].forEach((fn) => fn({ payload: { id, data, error, event } }));
const gh = () => T.hosts.github;
const pane = () => gh().el;
const answers = () => { T.answers.github_detail = (a: any) => DETAILS[a.target.kind]; T.answers.github_project = () => PROJECT; T.answers.github_day = () => DAYS; };
const settle = async () => { await flush(); gh().sync(); };
const openSheet = async (target: unknown, label = "x") => { enterGithubPanel({ target: target as never, label, url: "u" }); await settle(); };
const click = async (sel: string, nth = 0) => { (pane().querySelectorAll(sel)[nth] as HTMLElement).click(); await settle(); };

describe("github card", () => {
  it("card with data", () => snap("github-card", cardOf("integration_github", { loaded: true, data: GH as never })));
  it("card with data, no year", () => snap("github-card-noyear", cardOf("integration_github", { loaded: true, data: { ...GH, contributions: null, activity: [] } })));
  it("card with data and an error line", () => snap("github-card-error", cardOf("integration_github", { loaded: true, error: "rate limited", data: GH as never })));
  it("card not configured", () => snap("github-card-unconfigured", cardOf("integration_github", { configured: false })));
  it("card without data", () => snap("github-card-nodata", cardOf("integration_github", { configured: true })));
});

describe("github panel", () => {
  beforeAll(async () => {
    answers();
    info["integration_github"] = { data: {}, error: null, loaded: false, configured: true };
    feed("integration_github", GH as never);
    await settle();
  });


  it("activity", async () => { enterGithubPanel(); await settle(); snap("github-panel-activity", pane()); });
  it("contribution day", async () => {
    enterGithubPanel(); await settle();
    await click(".gh-grid i[data-i=\"40\"]");
    snap("github-panel-day", pane());
    await click(".gh-grid i[data-i=\"40\"]"); // a second click lets go
  });
  it("repos", async () => { enterGithubPanel(); await settle(); await click(".gh-step", 1); snap("github-panel-repos", pane()); });
  it("project sheet", async () => { await click(".pane-list .pane-row"); snap("github-panel-project", pane()); });
  for (const kind of ["pull", "issue", "commits", "release", "comments"] as const) {
    it(`${kind} sheet`, async () => {
      await openSheet({ kind, repo: "mochi-dev/coucou", number: 12, tag: "v0.6.1", head: null, count: null, branch: null, author: null, from: null, to: null });
      snap(`github-sheet-${kind === "commits" ? "commit" : kind}`, pane());
    });
  }
  it("files of a pull request", async () => {
    await openSheet({ kind: "pull", repo: "mochi-dev/coucou", number: 12 });
    snap("github-sheet-files", pane().querySelector(".pane-list")!);
  });
  it("diff of a file", async () => { await click(".pane-file"); snap("github-sheet-diff", pane()); });
  it("CI crew run", async () => {
    await openSheet({ kind: "run", repo: "mochi-dev/coucou", id: 900 });
    snap("github-sheet-run", pane());
    snap("github-sheet-run-crew", pane().querySelector(".gh-crew")!);
  });
  it("job of a run", async () => { await click(".gh-crew", 1); snap("github-sheet-job", pane()); });
  it("slow sheet shows the loader", async () => {
    T.answers.github_detail = () => new Promise((r) => setTimeout(() => r(DETAILS.issue), 400));
    enterGithubPanel({ target: { kind: "issue", repo: "mochi-dev/coucou", number: 7 }, label: "Crash on start", url: "u" });
    await vi.advanceTimersByTimeAsync(200); gh().sync();
    snap("github-sheet-loading", pane());
    await vi.advanceTimersByTimeAsync(400); answers();
  });
  it("sheet that failed", async () => {
    T.answers.github_detail = () => { throw new Error("Error: boom"); };
    await openSheet({ kind: "issue", repo: "mochi-dev/coucou", number: 8 });
    snap("github-sheet-error", pane()); answers();
  });
  it("fresh news notice over the panel", async () => {
    enterGithubPanel(); await settle();
    feed("integration_github", GH as never, null, { success: false, label: "CI falhou", detail: "test", open: { title: "CI falhou", says: "um build quebrou", facts: [{ kind: "repo", text: "coucou" }, { kind: "step", text: "Run tests" }], target: { kind: "run", repo: "mochi-dev/coucou", id: 900 } } });
    await settle();
    snap("github-panel-news", pane());
  });
  it("panel with an error and the last snapshot", async () => {
    enterGithubPanel(); await settle();
    feed("integration_github", {}, "sem rede");
    await settle();
    snap("github-panel-error", pane());
  });
});

describe("github locked sheet", () => {
  it("a sheet the token cannot read", async () => {
    T.answers.github_detail = () => DETAILS.locked;
    await openSheet({ kind: "run", repo: "mochi-dev/coucou", id: 5 });
    snap("github-sheet-locked", pane());
    answers();
  });
});

// ── Claude ──────────────────────────────────────────────────────────────────────────────────

const cl = () => T.claude as import("../../src/modules/claude/claude").Claude;
const OPEN_DOC = "src/app/main.ts";
const mk = (tool: string, kind: SessionStep["kind"], state: SessionStep["state"], target: string | null, extra: Partial<SessionStep> = {}, at = 600_000): SessionStep =>
  Object.assign(newStep(tool, kind, target), { state, at: NOW.getTime() - at }, extra);
const EDIT_PATCH = "@@ -3,4 +3,5 @@\n function a() {\n-  return 1;\n+  const v = 2;\n+  return v;\n }\n@@ -20,2 +21,2 @@\n tail\n-old\n+new";
const STEPS: SessionStep[] = [
  mk("Prompt", "prompt", "done", "Refatore o painel e rode os testes", {}, 900_000),
  mk("Read", "read", "done", OPEN_DOC, { result: { text: "import a from \"a\";\nexport const x = 1;\nexport function f() {}", start: 1, truncated: true, tail: false } }, 800_000),
  mk("Edit", "edit", "done", OPEN_DOC, { patch: EDIT_PATCH, permission: "allowed" }, 700_000),
  mk("Bash", "command", "done", "npm test\nand more", { result: { text: "ok 1\n\nok 2\nall green", start: null, truncated: false, tail: true }, permission: "denied" }, 600_000),
  mk("Bash", "command", "failed", "npm run build", { result: { text: "error TS2304", start: null, truncated: false, tail: true } }, 500_000),
  mk("Grep", "search", "done", "needle", { result: { text: "a.ts:1\nb.ts:2", start: null, truncated: false, tail: false } }, 400_000),
  mk("WebFetch", "other", "running", "https://example.com", { permission: "asked" }, 300_000),
  mk("AskUserQuestion", "other", "done", null, { questions: [
    { question: "Qual abordagem?", header: "Abordagem", multiSelect: false, options: [{ label: "A", description: "rápida" }, { label: "B", description: null }] },
    { question: "Extras?", header: null, multiSelect: true, options: [{ label: "X", description: null }, { label: "Y", description: null }] }],
    answers: { "Qual abordagem?": "A", "Extras?": "X, Z" } }, 250_000),
  mk("AskUserQuestion", "other", "running", null, { questions: [{ question: "Mais?", header: null, multiSelect: false, options: [{ label: "Sim", description: null }] }] }, 200_000),
  mk("Notification", "note", "done", "Claude está esperando", {}, 150_000),
  mk("Error", "note", "failed", "API error", {}, 120_000),
  mk("Done", "reply", "done", "Pronto. **Mudei** o painel:\n\n- item um\n- item dois\n\n```ts\nconst x = 1;\n```", {}, 60_000),
];
const FILES_CHANGED = [
  { path: OPEN_DOC, created: false, additions: 3, deletions: 2, at: NOW.getTime() - 700_000, edits: [
    { patch: EDIT_PATCH, additions: 2, deletions: 1, truncated: false, at: NOW.getTime() - 900_000 },
    { patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1, truncated: true, at: NOW.getTime() - 700_000 }] },
  { path: "docs/new.md", created: true, additions: 4, deletions: 0, at: NOW.getTime() - 800_000, edits: [{ patch: "@@ -0,0 +1,2 @@\n+# Novo\n+texto", additions: 2, deletions: 0, truncated: false, at: NOW.getTime() - 800_000 }] },
];
function seedClaude() {
  const c = cl();
  const a = newSession("s1");
  Object.assign(a, { title: "Refatorar o painel", project: "coucou", client: "vscode", state: "working", cwd: "C:/work/coucou", heardAt: NOW.getTime() - 30_000, steps: STEPS,
    lines: ["Edit src/app/main.ts"], asked: "Refatore o painel", answer: "Pronto. Mudei o painel.\nSegunda linha.", answeredAt: NOW.getTime() - 60_000 });
  const b = newSession("s2");
  Object.assign(b, { project: "api-server", client: "terminal", state: "idle", heardAt: NOW.getTime() - 2 * HOUR, news: "done", lines: ["Bash npm test"] });
  c.store.sessions = [a, b];
  c.store.frontId = "s1";
  c.store.changes = new Map([["s1", FILES_CHANGED as never]]);
  c.store.present();
  T.apis.claude.pills.focus("integration_claude");
  return { a, b };
}
const front = () => cl().store.session;
const go = async (view: string) => { island.open(view); await flush(); };
const showing = async (name: string) => { await go(name); T.hosts[name].sync(); return T.hosts[name].el; };

describe("claude cards", () => {
  beforeAll(() => { seedClaude(); });

  it("approval for a command", async () => {
    front().approval = { requestId: "r1", sessionId: "s1", tool: "Bash", command: "rm -rf build && npm run build", proposal: null, plan: null };
    snap("claude-approval", await showing("approval"));
  });
  it("approval for an edit", async () => {
    front().approval = { requestId: "r2", sessionId: "s1", tool: "Edit", command: "", plan: null,
      proposal: { path: OPEN_DOC, patch: EDIT_PATCH, additions: 2, deletions: 1, truncated: true, created: true } };
    snap("claude-approval-edit", await showing("approval"));
  });
  it("approval for a plan", async () => {
    front().approval = { requestId: "r3", sessionId: "s1", tool: "ExitPlanMode", command: "", proposal: null, plan: "# Plano\n\n1. um\n2. dois\n\n`code`" };
    snap("claude-approval-plan", await showing("approval"));
    front().approval = null;
  });
  it("approval with another session waiting", async () => {
    cl().store.sessions[1].question = { requestId: "q0", sessionId: "s2", questions: [] };
    front().approval = { requestId: "r4", sessionId: "s1", tool: "Bash", command: "ls", proposal: null, plan: null };
    snap("claude-approval-waiting", await showing("approval"));
    front().approval = null;
    cl().store.sessions[1].question = null;
  });
  it("question with explained options", async () => {
    front().question = { requestId: "q1", sessionId: "s1", questions: [
      { question: "Qual abordagem?", header: "Abordagem", multiSelect: false, options: [{ label: "Rápida", description: "menos código" }, { label: "Segura", description: "mais testes" }] }] };
    snap("claude-question", await showing("question"));
  });
  it("question with bare options", async () => {
    front().question = { requestId: "q2", sessionId: "s1", questions: [
      { question: "Continuar?", header: null, multiSelect: false, options: [{ label: "Sim", description: null }, { label: "Não", description: null }] }] };
    snap("claude-question-bare", await showing("question"));
  });
  it("question with several to pick, one of two", async () => {
    front().question = { requestId: "q3", sessionId: "s1", questions: [
      { question: "Extras?", header: "Extras", multiSelect: true, options: [{ label: "X", description: "um" }, { label: "Y", description: "dois" }] },
      { question: "Depois?", header: null, multiSelect: false, options: [{ label: "Z", description: null }] }] };
    snap("claude-question-multi", await showing("question"));
    front().question = null;
  });
  it("question with nothing to ask", async () => {
    front().question = null;
    snap("claude-question-none", await showing("question"));
  });
  it("finished with an answer and changes", async () => {
    front().state = "done";
    snap("claude-finished", await showing("finished"));
  });
  it("finished without an answer", async () => {
    front().answer = null;
    snap("claude-finished-bare", await showing("finished"));
    front().answer = "Pronto. Mudei o painel.\nSegunda linha.";
  });
  it("error", async () => {
    front().state = "error";
    front().lines = ["Command failed: exit 1"];
    snap("claude-error", await showing("error"));
    front().state = "working";
  });
  it("news on the result cards (github pill in front)", async () => {
    T.apis.github.pills.focus("integration_github");
    snap("claude-error-news", await showing("error"));
    snap("claude-finished-news", await showing("finished"));
    T.apis.claude.pills.focus("integration_claude");
  });
});

describe("claude session panel", () => {
  beforeAll(() => { seedClaude(); });

  it("journal", async () => { enterSessionPanel("journal"); snap("claude-session-journal", await showing("session")); });
  it("changes list", async () => { enterSessionPanel("changes"); snap("claude-session-changes", await showing("session")); });
  it("file diff", async () => {
    const el = await showing("session");
    (el.querySelector(".pane-file") as HTMLElement).click();
    T.hosts.session.sync();
    snap("claude-session-file", el);
  });
  it("sessions of the panel", async () => { enterSessionPanel("sessions"); snap("claude-session-sessions", await showing("session")); });
  it("empty journal", async () => {
    cl().store.frontId = "";
    cl().store.present();
    enterSessionPanel("journal");
    snap("claude-session-empty", await showing("session"));
    cl().store.frontId = "s1";
    cl().store.present();
  });
  it("session row parts: head, side", async () => {
    enterSessionPanel("journal");
    const el = await showing("session");
    snap("claude-session-head", el.querySelector(".pane-head")!);
    snap("claude-session-side", el.querySelector(".pane-side")!);
  });
});

describe("claude sessions list", () => {
  it("managed sessions", async () => {
    seedClaude();
    T.answers.claude_profiles = () => [{ key: "", label: "Padrão", isDefault: true }, { key: "work", label: "Trabalho", isDefault: false }];
    T.answers.claude_sessions_all = () => [
      { id: "s1", profile: "", title: "Refatorar o painel", cwd: "C:/work/coucou", updated: NOW.getTime() - 5 * MIN, status: "running", pid: 1 },
      { id: "s3", profile: "work", title: "", cwd: "C:/work/site/", updated: NOW.getTime() - 3 * DAY, status: "idle", pid: null },
    ];
    T.answers.claude_sessions_live = () => [{ id: "s1", profile: "", pid: 11 }];
    await go("sessions");
    T.hosts.sessions.sync();
    await flush();
    T.hosts.sessions.sync();
    snap("claude-sessions", T.hosts.sessions.el);
  });
  it("no sessions", async () => {
    T.answers.claude_sessions_all = () => [];
    T.answers.claude_profiles = () => [{ key: "", label: "Padrão", isDefault: true }];
    await go("approval"); T.hosts.sessions.sync();
    await go("sessions"); T.hosts.sessions.sync(); await flush(); T.hosts.sessions.sync();
    snap("claude-sessions-empty", T.hosts.sessions.el);
  });
});

describe("claude on the board", () => {
  it("the session card in the board's home", async () => {
    seedClaude();
    snap("claude-board-session", await showing("overview"));
  });
  it("the idle claude card", async () => {
    cl().store.frontId = "";
    cl().store.present();
    snap("claude-board-idle", await showing("overview"));
    cl().store.frontId = "s1";
    cl().store.present();
  });
});

// ── Media, upload, voice, clock, timer ──────────────────────────────────────────────────────

const ITEMS = [
  { path: "C:/Users/me/Pictures/Screenshots/print 1.png", name: "print 1.png", kind: "screenshot", ts: NOW.getTime() - 5 * MIN, size: 120_000 },
  { path: "C:/Users/me/Videos/Captures/clip.mp4", name: "clip.mp4", kind: "video", ts: NOW.getTime() - 3 * DAY, size: 9_000_000 },
  { path: "C:/inbox/notes.pdf", name: "notes.pdf", kind: "file", ts: NOW.getTime() - 40 * DAY, size: 5000 },
];

describe("media panel", () => {
  it("empty", async () => {
    T.answers.media_list = () => [];
    snap("media-empty", await showing("media")); await flush();
    snap("media-empty-loaded", T.hosts.media.el);
  });
  it("with items", async () => {
    T.answers.media_list = () => ITEMS;
    T.apis.media.island.setView("overview"); await flush(); T.hosts.media.sync();
    await go("media"); T.hosts.media.sync(); await flush();
    snap("media-items", T.hosts.media.el);
  });
  it("action menu open", async () => {
    (T.hosts.media.el.querySelector(".media-more") as HTMLElement).click();
    snap("media-menu", T.hosts.media.el);
  });
  it("list that failed", async () => {
    T.answers.media_list = () => { throw new Error("Error: sem acesso"); };
    await go("overview"); T.hosts.media.sync();
    await go("media"); T.hosts.media.sync(); await flush();
    snap("media-error", T.hosts.media.el);
  });
});

describe("upload views", () => {
  it("drop zone", async () => { snap("upload-drop", await showing("upload")); });
  it("drop zone with a file over it", async () => {
    Up.dragOver = true;
    snap("upload-drop-over", await showing("upload"));
    Up.dragOver = false;
  });
  it("uploading", async () => {
    Up.droppedFile = { name: "relatorio.pdf", path: "C:/inbox/relatorio.pdf" }; Up.progress = 0.4;
    snap("upload-uploading", await showing("uploading"));
  });
  it("uploading done", async () => {
    Up.progress = 1;
    snap("upload-uploading-done", await showing("uploading"));
  });
  it("uploading barely started", async () => {
    Up.progress = 0;
    snap("upload-uploading-start", await showing("uploading"));
  });
  it("choose", async () => { snap("upload-choose", await showing("choose")); });
  it("choose without a name", async () => {
    Up.droppedFile = null;
    snap("upload-choose-bare", await showing("choose"));
  });
});

describe("voice card", () => {
  const phase = async (p: Voice["phase"], text = "", note = "") => { Voice.phase = p; Voice.text = text; Voice.note = note; return showing("voice"); };
  it("listening", async () => snap("voice-listening", await phase("listening")));
  it("transcribing", async () => snap("voice-transcribing", await phase("transcribing")));
  it("review", async () => snap("voice-review", await phase("review", "open the settings and\nturn the sound off")));
  it("sending", async () => snap("voice-sending", await phase("sending")));
  it("error", async () => snap("voice-error", await phase("error", "", "Sem microfone")));
  it("idle", async () => snap("voice-none", await phase("none")));
});

describe("clock and timer", () => {
  it("clock", async () => { snap("clock-view", await showing("clock")); });
  it("clock after a second", async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 61_000)); await vi.advanceTimersByTimeAsync(1100);
    snap("clock-view-later", T.hosts.clock.el); vi.setSystemTime(NOW);
  });
  it("timer idle", async () => { snap("timer-idle", await showing("timer")); });
  it("timer ready", async () => {
    (T.hosts.timer.el.querySelectorAll(".timer-row .btn")[1] as HTMLElement).click(); // 10 min
    T.hosts.timer.sync();
    snap("timer-ready", T.hosts.timer.el);
  });
  it("timer running", async () => {
    (T.hosts.timer.el.querySelector(".btn.primary") as HTMLElement).click();
    vi.setSystemTime(new Date(NOW.getTime() + 90_000));
    T.hosts.timer.sync();
    snap("timer-running", T.hosts.timer.el);
  });
  it("timer paused", async () => {
    (T.hosts.timer.el.querySelector(".timer-row .btn.secondary") as HTMLElement).click();
    T.hosts.timer.sync();
    snap("timer-paused", T.hosts.timer.el);
  });
  it("stopwatch", async () => {
    (T.hosts.timer.el.querySelector(".timer-row .text-link") as HTMLElement).click(); // Cancelar
    T.hosts.timer.sync();
    (T.hosts.timer.el.querySelector(".timer-row .text-link") as HTMLElement).click(); // Cronômetro
    T.hosts.timer.sync();
    snap("timer-stopwatch-ready", T.hosts.timer.el);
    (T.hosts.timer.el.querySelector(".btn.primary") as HTMLElement).click();
    vi.setSystemTime(new Date(NOW.getTime() + 125_000));
    T.hosts.timer.sync();
    snap("timer-stopwatch-running", T.hosts.timer.el);
    (T.hosts.timer.el.querySelector(".text-link") as HTMLElement).click();
    vi.setSystemTime(NOW);
  });
});

// ── The board, last: the other modules are stopped to get its empty and plain looks ─────────

describe("board", () => {
  const board = () => T.apis.board;
  it("with every pill (an integration card in front)", async () => {
    T.apis.vercel.pills.focus("integration_vercel");
    feed("integration_vercel", DATA.integration_vercel);
    await flush();
    snap("board-pills", await showing("overview"));
  });
  it("empty", async () => {
    Registry.apply(Object.fromEntries(MODULES.map((m) => [m.id, m.id === "board"])));
    await flush();
    snap("board-empty", await showing("overview"));
  });
  it("plain card of a pill nobody draws", async () => {
    board().pills.set({ id: "p1", label: "Alpha", color: "#88aaff", mood: "idle" });
    await flush();
    snap("board-plain", await showing("overview"));
  });
  it("plain card and pills, with badges", async () => {
    board().pills.set({ id: "p2", label: "Beta", color: "#ffaa88", mood: "working", badge: "done" });
    board().pills.set({ id: "p3", label: "Gama", color: "#aaffaa", mood: "idle", badge: "error" });
    board().pills.set({ id: "p4", label: "Delta", color: "#ffaaff", mood: "idle", badge: "alert" });
    board().pills.set({ id: "p5", label: "Épsilon", color: "#ffffaa", mood: "idle" });
    board().pills.set({ id: "p6", label: "Hidden sixth", color: "#cccccc", mood: "idle" });
    await flush();
    snap("board-pills-badged", await showing("overview"));
  });
});
