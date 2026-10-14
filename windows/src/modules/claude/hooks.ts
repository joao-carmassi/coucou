// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// client — the Claude desktop app, VS Code, Windows Terminal, PowerShell… — and
// all of them are handled.
//
// Windows goes a step further than the Swift app on two things, both read from
// what the hooks already carry: what Claude is doing — each file it changes,
// what it said to end its turn (the session panel) — and the questions it asks
// with its question tool, answered on the island.

import { ClaudeBridge } from "./bridge";
import {
  CLAUDE_ID, PLAN_TOOL, QUESTION_TOOL, SESSION_UNNAMED, TURN_DONE, newSession, newStep,
  type ChangedFile, type ClaudeClient, type ClaudeSession, type Question, type StepKind, type StepResult,
} from "./types";
import type { Claude } from "./claude";

type IslandViewName = string;

/**
 * By session (Claude.pending): clears its request if no decision was made before the hook gave
 * up. Coucou answers within 108 s or not at all; after that the terminal has
 * taken over and the card would be lying.
 */
export const PENDING_MS = 110_000;

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  /** The Claude profile (CLAUDE_CONFIG_DIR) the session runs under. */
  config_dir?: string;
  /** Added by coucou-hook when the session runs under WSL. */
  wsl_distro?: string;
  /** Added by coucou-hook: its ancestor processes, nearest first. */
  terminal_pids?: number[];
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** CLAUDE_CODE_ENTRYPOINT and TERM_PROGRAM, added by coucou-hook. */
  entrypoint?: string;
  term_program?: string;
  /** What an edit tool did to its file — added by coucou-hook to PostToolUse. */
  change?: { patch: string; additions: number; deletions: number; truncated: boolean; created: boolean };
  /** A few lines of what a tool gave back — added by coucou-hook to PostToolUse. */
  result?: StepResult;
  /** On a PostToolUseFailure: what went wrong. */
  error?: string;
  /** What was picked for each question of Claude's question tool — added by coucou-hook to PostToolUse. */
  answers?: Record<string, string>;
  /** What an edit asking for permission would do — added by coucou-hook to PermissionRequest. */
  /** ExitPlanMode asking for approval: the plan, whole (coucou-hook). */
  plan?: string;
  proposal?: { patch: string; additions: number; deletions: number; truncated: boolean; created: boolean };
  /** The conversation's title, read by coucou-hook from the session's transcript. */
  session_title?: string;
  /** On a Stop: what Claude said to end its turn. */
  last_message?: string;
}

/** Sessions followed at once: as many as the island has tabs for. */
const MAX_SESSIONS = 4;
/** Files kept for a session, and edits kept for a file. */
const MAX_FILES = 40;
const MAX_EDITS = 12;
/**
 * Lines kept of a session's journal. It empties as it fills: past that, the
 * oldest line goes for each new one, so a session that runs all day costs no
 * more than one that just started.
 */
const MAX_STEPS = 80;
/** Lines kept of what a session did; past that the older half goes. */
const MAX_LINES = 200;
/** Such a line is this long at most. */
const LINE_CHARS = 60;
/** How long a session that just finished says so before it goes back to rest. */
const FINISHED_MS = 5_200;
/** The id of a session whose hooks carry none. */
const ANONYMOUS = "session";

/** What each tool does, as far as showing it goes; one not listed is "other". */
const STEP_KINDS: Record<string, StepKind> = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "command", PowerShell: "command",
  Grep: "search", Glob: "search", WebSearch: "search", ToolSearch: "search",
};

/** The fields of a tool's input that say what it is at, the most telling first. */
const TARGET_FIELDS = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "description"] as const;
const PATH_FIELDS: ReadonlySet<string> = new Set(["file_path", "notebook_path", "path"]);

/** What a tool is at: its file by its path in the session's folder, its command, what it looks for. */
function stepTarget(input: Record<string, unknown>, cwd: string): string | null {
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return PATH_FIELDS.has(field) ? sessionPath(value, cwd) : value.trim();
  }
  return null;
}

/** One more line in the session's journal. */
function log(session: ClaudeSession, step: ReturnType<typeof newStep>) {
  session.steps.push(step);
  if (session.steps.length > MAX_STEPS) session.steps.shift();
  return step;
}

/** The step of a tool still going, the last one started. */
function goingStep(session: ClaudeSession, tool: string) {
  return [...session.steps].reverse().find((s) => s.tool === tool && s.state === "running") ?? null;
}

/** A tool starts: one more step, going. */
function startStep(session: ClaudeSession, tool: string, input: Record<string, unknown>, cwd: string) {
  const step = log(session, newStep(tool, STEP_KINDS[tool] ?? "other", stepTarget(input, cwd)));
  if (tool === QUESTION_TOOL) step.questions = questionsOf(input);
}

/** A tool ends: its last step still going takes the outcome, and what the tool gave back. */
function endStep(session: ClaudeSession, payload: HookPayload, state: "done" | "failed") {
  const step = goingStep(session, payload.tool_name ?? "Tool");
  if (!step) return;
  step.state = state;
  step.at = Date.now();
  step.patch = payload.change?.patch ?? null;
  step.result = payload.result ?? (payload.error ? { text: payload.error, start: null, truncated: false, tail: false } : null);
  if (payload.answers) step.answers = payload.answers;
  // It ran, so whoever was asked said yes — here or in Claude Code.
  if (step.permission === "asked") step.permission = state === "done" ? "allowed" : "denied";
}

/** The turn ends: nothing is going any more, and the journal closes on what Claude said. */
function closeSteps(session: ClaudeSession, answer: string | null) {
  for (const step of session.steps) if (step.state === "running") step.state = "done";
  log(session, newStep(TURN_DONE, "reply", answer));
}

/** One more line of what the session did. */
function say(session: ClaudeSession, line: string) {
  session.lines.push(line);
  if (session.lines.length > MAX_LINES) session.lines.splice(0, MAX_LINES / 2);
}

/** How the Agent SDK names itself as an entry point: "sdk-ts", "sdk-py", "sdk-cli". */
const SDK_ENTRYPOINT = "sdk";

/**
 * A session started by a program rather than a person — a review a plugin runs
 * on each commit, a script. It sends the same hooks from the same folder, and
 * followed like any other it would take the island away from the conversation
 * the user is in, steps, title and all.
 */
function isAutomated(payload: HookPayload): boolean {
  return (payload.entrypoint ?? "").toLowerCase().startsWith(SDK_ENTRYPOINT);
}

function clientOf(payload: HookPayload): ClaudeClient {
  const entry = (payload.entrypoint ?? "").toLowerCase();
  if (entry.includes("desktop")) return "desktop";
  if (entry.includes("vscode") || (payload.term_program ?? "").toLowerCase().includes("vscode")) return "vscode";
  return "terminal";
}

const waits = (session: ClaudeSession) => session.approval != null || session.question != null;

/** No turn under way, and nothing asked: the session is where its last turn left it. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "done", "error", "sleeping"]);
const resting = (session: ClaudeSession) => AT_REST.has(session.state) && !waits(session);

/** The session an event comes from, told what the event says of it. A new one gets a place. */
function sessionOf(c: Claude, payload: HookPayload): ClaudeSession {
  const id = payload.session_id || ANONYMOUS;
  let session = c.store.sessions.find((s) => s.id === id);
  if (!session) {
    session = newSession(id);
    c.store.sessions.push(session);
    makeRoom(c, session);
  }
  session.client = clientOf(payload);
  session.profile = payload.config_dir ?? session.profile;
  if (payload.session_title) session.title = payload.session_title;
  if (payload.cwd) {
    session.cwd = payload.cwd;
    // The distro goes with the folder: a Windows session after a WSL one clears it.
    session.wslDistro = payload.wsl_distro || null;
    session.terminalPids = Array.isArray(payload.terminal_pids) ? payload.terminal_pids : [];
    session.project = aliasProjectName(lastPathComponent(payload.cwd) || SESSION_UNNAMED);
  }
  session.heardAt = Date.now();
  return session;
}

/**
 * One session too many: the one that goes is at rest if any is, and the one
 * heard from longest ago. Never the one in front, the one that just came, or
 * one that is waiting for an answer.
 */
function makeRoom(c: Claude, newcomer: ClaudeSession) {
  while (c.store.sessions.length > MAX_SESSIONS) {
    const old = c.store.sessions
      .filter((s) => s !== newcomer && s.id !== c.store.frontId && !waits(s))
      .sort((a, b) => Number(resting(b)) - Number(resting(a)) || a.heardAt - b.heardAt)[0];
    if (!old) return;
    forget(c, old);
  }
}

/** A session is over, or gave its place: nothing of it is kept. */
function forget(c: Claude, session: ClaudeSession) {
  const at = c.store.sessions.indexOf(session);
  if (at < 0) return;
  const request = (session.approval ?? session.question)?.requestId;
  if (request) void ClaudeBridge.approvalDecline(request);
  stopWaiting(c, session);
  c.store.sessions.splice(at, 1);
  c.store.changes.delete(session.id);
  if (session.id !== c.store.frontId) return;
  // It was in front: the one heard from last takes its place.
  const next = [...c.store.sessions].sort((a, b) => b.heardAt - a.heardAt)[0];
  c.store.bringForward(next?.id ?? "");
  c.afterRequest(onCard(c));
}

/** True while the island shows a request's card. */
const onCard = (c: Claude) => c.api.island.mode() === "expanded" && (c.api.island.view() === "approval" || c.api.island.view() === "question");

/** The views that are about the session in front: it is not changed under them. */
const ABOUT_FRONT: ReadonlySet<IslandViewName> = new Set(["session", "finished", "error", "approval", "question"]);
/** The events that say a session is being worked in. */
const WORK_EVENTS: ReadonlySet<string> = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse"]);

/**
 * Whether the session an event comes from takes the front. The island stays on
 * the session it shows for as long as that one is at work or being looked at:
 * another one takes its place when it has nothing going on, or to ask for
 * something — unless the one in front is itself waiting for an answer, and
 * then the request waits its turn.
 */
function takesFront(c: Claude, session: ClaudeSession, event: string): boolean {
  const front = c.store.session;
  if (!front.id) return true;
  if (front === session || waits(front)) return false;
  if (event === "PermissionRequest") return true;
  const watched = c.api.island.mode() === "expanded" && ABOUT_FRONT.has(c.api.island.view());
  return WORK_EVENTS.has(event) && resting(front) && !watched;
}

/** "C:\\work\\app\\src\\a.ts" in "C:\\work\\app" → "src/a.ts". Outside the folder, the whole path. */
function sessionPath(file: string, cwd: string): string {
  const path = file.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
}

/** One more edit to a file: the file moves to the top of the session's changes. */
function recordChange(c: Claude, session: ClaudeSession, payload: HookPayload) {
  const change = payload.change;
  const file = payload.tool_input?.file_path;
  if (!change || typeof file !== "string") return;
  const path = sessionPath(file, payload.cwd ?? "");
  const files = c.store.changes.get(session.id) ?? [];
  const at = files.findIndex((f) => f.path === path);
  const entry: ChangedFile =
    at >= 0 ? files.splice(at, 1)[0] : { path, created: change.created, additions: 0, deletions: 0, edits: [], at: 0 };
  entry.edits.push({
    patch: change.patch, additions: change.additions, deletions: change.deletions,
    truncated: change.truncated, at: Date.now(),
  });
  if (entry.edits.length > MAX_EDITS) entry.edits.shift();
  entry.additions += change.additions;
  entry.deletions += change.deletions;
  entry.at = Date.now();
  files.unshift(entry);
  if (files.length > MAX_FILES) files.pop();
  c.store.changes.set(session.id, files);
}

/** The question tool's input as the island shows it — null when it is not one it can answer. */
function questionsOf(input: Record<string, unknown>): Question[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    const options = Array.isArray(q?.options) ? (q.options as Record<string, unknown>[]) : [];
    if (typeof q?.question !== "string" || options.some((o) => typeof o?.label !== "string")) return null;
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : null,
      options: options.map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : null,
      })),
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}

/** The relay's wait for this session's request is no longer the island's to time. */
function stopWaiting(c: Claude, session: ClaudeSession) {
  c.pending.get(session.id)?.();
  c.pending.delete(session.id);
}

/**
 * A session's request is no longer needed: it was answered in Claude Code
 * itself, or the relay stopped waiting. The island lets go of it.
 */
function dropPending(c: Claude, session: ClaudeSession) {
  stopWaiting(c, session);
  if (!waits(session)) return;
  session.approval = null;
  session.question = null;
  session.state = "working";
  if (session.news === "alert") session.news = null;
  if (session.id === c.store.frontId) c.afterRequest(onCard(c));
}

/** True when this event says the tool the session's request is about has run: someone answered elsewhere. */
function answeredElsewhere(session: ClaudeSession, payload: HookPayload): boolean {
  if (!waits(session)) return false;
  return payload.tool_name === (session.question ? QUESTION_TOOL : session.approval?.tool);
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * What a tool does, in a word — the macOS app's frenchStep(), in English like
 * the rest of the island here.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Executa",
  Read: "Lê",
  Write: "Escreve",
  Edit: "Edita",
  Glob: "Busca",
  Grep: "Pesquisa",
  WebSearch: "Pesquisa na web",
  WebFetch: "Busca",
  TodoWrite: "Tarefas",
  Task: "Agente",
  LS: "Lista",
  MultiEdit: "Edita",
  NotebookEdit: "Notebook",
  PowerShell: "Executa",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

/**
 * An event from a third-party agent (docs/AGENTS.md): it has a pill of its
 * own, "agent_<name>", created on its first event and gone when it is done.
 * None of what follows a Claude Code session — its journal, its questions —
 * applies to it: the pill wears the agent's state and its last steps.
 */
function handleAgent(c: Claude, payload: HookPayload, agent: string) {
  const agentId = `agent_${agent}`;
  const name = payload.hook_event_name ?? "";
  const focused = c.focusId() === agentId;
  const ensurePill = () => c.upsertAgent(agentId, agent, agentColor(agent));
  const reveal = () => {
    if (c.api.island.mode() === "hidden") c.api.island.wake();
  };
  const alert = (view: IslandViewName) => (c.api.island.mode() === "expanded" ? c.api.island.setView(view) : c.alert(view));

  switch (name) {
    case "SessionStart":
      ensurePill();
      reveal();
      c.api.sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      c.updateTask(agentId, "thinking");
      const asked = payload.prompt ?? payload.message;
      if (asked) c.appendStep(agentId, asked.slice(0, LINE_CHARS));
      reveal();
      break;
    }

    case "PreToolUse":
      ensurePill();
      c.updateTask(agentId, "working");
      c.appendStep(agentId, stepLabel(payload.tool_name ?? "Tool", payload.tool_input ?? {}));
      reveal();
      break;

    case "PostToolUse":
      c.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      c.updateTask(agentId, "working");
      c.appendStep(agentId, "⚠ falhou");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        c.updateTask(agentId, "waiting");
        c.api.sound.play("wait");
      } else if (message.endsWith("?")) {
        c.updateTask(agentId, "ask");
        c.appendStep(agentId, message);
      }
      break;
    }

    case "Stop":
      c.updateTask(agentId, "done");
      if (payload.message) c.appendStep(agentId, payload.message.slice(0, LINE_CHARS));
      c.api.sound.play("finish");
      if (focused) alert("finished");
      else {
        c.store.setBadge(agentId, "done");
        if (c.api.island.mode() === "hidden") c.api.island.wake();
      }
      c.api.timeout(() => c.removeAgent(agentId), FINISHED_MS);
      break;

    case "StopFailure":
      c.updateTask(agentId, "error");
      c.api.sound.play("error");
      if (focused) alert("error");
      else c.store.setBadge(agentId, "error");
      break;

    case "SessionEnd":
      c.removeAgent(agentId);
      break;

    case "SubagentStart":
      c.appendStep(agentId, "+ subagente");
      break;

    case "SubagentStop":
      c.appendStep(agentId, "• subagente concluiu");
      break;

    case "PermissionRequest":
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (payload.request_id) void ClaudeBridge.approvalDecline(payload.request_id);
      break;

    default:
      break;
  }
  c.store.changed();
}

export function handleHook(c: Claude, payload: HookPayload) {
  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code, as before.
  const agent = validateAgent(payload.coucou_agent);
  if (agent && !c.api.paused()) return handleAgent(c, payload, agent);

  // A session that ended must be forgotten even while paused, or it stays "working".
  if (payload.hook_event_name === "SessionEnd") {
    const over = c.store.sessions.find((s) => s.id === (payload.session_id || ANONYMOUS));
    if (over) forget(c, over);
    c.store.changed();
    return;
  }

  // Paused, or a session nobody is sitting in front of: the island does not look.
  if (c.api.paused() || isAutomated(payload)) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void ClaudeBridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";

  const session = sessionOf(c, payload);
  if (takesFront(c, session, name)) c.store.bringForward(session.id);
  /** The session the island shows; the others go on behind their tabs. */
  const front = session.id === c.store.frontId;
  const focused = front && c.focusId() === CLAUDE_ID;
  const cwd = payload.cwd ?? "";

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: IslandViewName | null) => {
    if (c.api.island.mode() === "expanded") {
      if (view) c.api.island.setView(view);
    } else if (view) {
      c.alert(view);
    } else if (c.api.island.mode() === "hidden") {
      c.api.island.wake();
    }
  };

  /**
   * A turn's end, good or bad: its card when the session is in front, a mark
   * on its tab when it is behind, a badge on the pill when Claude's is not
   * the one in front.
   */
  const tell = (what: "done" | "error") => {
    if (focused) return surface(what === "done" ? "finished" : "error");
    if (!front) session.news = what;
    if (c.focusId() !== CLAUDE_ID) c.store.setBadge(CLAUDE_ID, what);
    // The sound already played: a hidden island has to show up too (it folds back on its own),
    // or a session that ends behind the front one is heard and never seen.
    if (c.api.island.mode() === "hidden") c.api.island.wake();
  };

  switch (name) {
    case "SessionStart":
      surface(null);
      c.api.sound.play("work");
      break;

    case "UserPromptSubmit": {
      session.state = "thinking";
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      // What Claude Code feeds itself as a prompt — a task's notification, a
      // reminder — comes as markup, and is nobody's words to show.
      if (asked && !asked.trimStart().startsWith("<")) {
        session.asked = asked;
        session.answer = null;
        log(session, newStep("Prompt", "prompt", asked));
        say(session, asked.slice(0, LINE_CHARS));
      }
      surface(null);
      break;
    }

    case "PreToolUse": {
      session.state = "working";
      const tool = payload.tool_name ?? "Tool";
      startStep(session, tool, payload.tool_input ?? {}, cwd);
      say(session, stepLabel(tool, payload.tool_input ?? {}));
      surface(null);
      break;
    }

    case "PostToolUse":
      if (answeredElsewhere(session, payload)) dropPending(c, session);
      endStep(session, payload, "done");
      recordChange(c, session, payload);
      session.state = "working";
      break;

    case "PostToolUseFailure":
      if (answeredElsewhere(session, payload)) dropPending(c, session);
      endStep(session, payload, "failed");
      session.state = "working";
      say(session, "⚠ falhou");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        session.state = "waiting";
        c.api.sound.play("wait");
      } else if (message.endsWith("?")) {
        session.state = "ask";
        say(session, message);
      }
      if (message) log(session, newStep("Notification", "note", message));
      break;
    }

    case "Stop":
      if (payload.last_message) {
        session.answer = payload.last_message;
        session.answeredAt = Date.now();
      }
      closeSteps(session, payload.last_message ?? null);
      session.agentsRunning = session.agentsLaunched = 0;
      session.state = "done";
      if (payload.message) say(session, payload.message.slice(0, LINE_CHARS));
      c.api.sound.play("finish");
      tell("done");
      c.api.timeout(() => {
        // Still where its turn left it: back to rest. Its tab keeps its mark.
        if (session.state === "done") session.state = "idle";
        if (session.id === c.store.frontId) c.store.setBadge(CLAUDE_ID, null);
        c.store.present();
      }, FINISHED_MS);
      break;

    case "StopFailure":
      log(session, newStep("Error", "note", "A sessão parou com um erro.")).state = "failed";
      session.agentsRunning = session.agentsLaunched = 0;
      session.state = "error";
      c.api.sound.play("error");
      tell("error");
      break;

    case "SubagentStart":
      session.agentsRunning++;
      session.agentsLaunched++;
      say(session, "+ subagente");
      log(session, newStep("Subagent", "note", "Um subagente começou."));
      break;

    case "SubagentStop":
      session.agentsRunning = Math.max(0, session.agentsRunning - 1);
      if (!session.agentsRunning) session.agentsLaunched = 0;
      say(session, "• subagente concluiu");
      log(session, newStep("Subagent", "note", "Um subagente terminou."));
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      // One request per session. A second one must never quietly replace the
      // first — that would leave a human staring at request B while request A
      // waits for a decision nobody can give. Hand it straight back to the terminal.
      const held = session.approval ?? session.question;
      if (held && held.requestId !== requestId) {
        if (requestId) void ClaudeBridge.approvalDecline(requestId);
        break;
      }
      stopWaiting(c, session);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      // Claude's question tool asks for permission like any other: allowing it
      // with the answers is how a question gets answered from here.
      const questions = tool === QUESTION_TOOL ? questionsOf(input) : null;
      if (questions) session.question = { requestId, sessionId: session.id, questions };
      else {
        const file = input.file_path;
        const proposal =
          payload.proposal && typeof file === "string" ? { path: sessionPath(file, cwd), ...payload.proposal } : null;
        const plan = tool === PLAN_TOOL ? (payload.plan ?? "") : null;
        session.approval = { requestId, sessionId: session.id, tool, command: approvalTarget(tool, input), proposal, plan };
      }
      // The journal says the tool had to ask, and later what it was told.
      const asking = goingStep(session, tool);
      if (asking) asking.permission = "asked";
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void ClaudeBridge.approvalAck(requestId);
      session.state = questions ? "ask" : "alert";
      c.api.sound.play(questions ? "ask" : "alert");
      if (!front) {
        // The session in front is waiting for an answer of its own: this one
        // waits its turn behind its tab, and gets the card next.
        session.news = "alert";
      } else if (focused) {
        c.syncRequest(true);
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        c.syncRequest(false);
        c.store.setBadge(CLAUDE_ID, "alert");
        c.api.island.wake();
      }
      c.pending.set(session.id, c.api.timeout(() => {
        dropPending(c, session);
        c.store.present();
      }, PENDING_MS));
      break;
    }

    default:
      break;
  }
  c.store.present();
}
