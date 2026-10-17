// Pure rules of the Agentes module: hook event -> pill state, and what an approval shows.
import type { BotStateName } from "../../core/layout";

export interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  coucou_agent?: string;
  session_id?: string;
  message?: string;
  prompt?: string;
  last_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface AgentState { mood: BotStateName; step: string; done: boolean; error: boolean; ended: boolean }
export const FRESH: AgentState = { mood: "idle", step: "", done: false, error: false, ended: false };

/** The pill goes this long after a turn ends. */
export const FINISHED_MS = 5200;
/** An approval card is dropped this long after it came up: the relay gave up (110 s) and the agent asks by itself. */
export const PENDING_MS = 110_000;
/** Y/N never answer within this long of the card appearing: a keystroke meant elsewhere must not approve. */
export const KEY_GUARD_MS = 500;
const LINE = 120;

const one = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, LINE);
const FIELDS = ["command", "file_path", "path", "url", "query", "pattern"] as const;

/** What a tool is about, in one line: the command, file or address. */
export function targetOf(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  const name = tool || "Ferramenta";
  for (const f of FIELDS) {
    const v = input?.[f];
    const text = Array.isArray(v) ? v.join(" ") : v;
    if (typeof text === "string" && text.trim()) return `${name} · ${text.trim().slice(0, 300)}`;
  }
  return name;
}

/** A hook event moves the pill. PermissionRequest is not here: it is a card, not a state. */
export function apply(prev: AgentState, p: HookPayload): AgentState {
  const s = { ...prev, done: false, error: false };
  const message = p.message ?? "";
  switch (p.hook_event_name) {
    case "SessionStart": return { ...s, mood: "idle", ended: false };
    case "UserPromptSubmit": return { ...s, mood: "thinking", step: one(p.prompt ?? p.message) || s.step, ended: false };
    case "PreToolUse": return { ...s, mood: "working", step: one(targetOf(p.tool_name, p.tool_input)), ended: false };
    case "PostToolUse": return { ...s, mood: "working", ended: false };
    case "Notification": {
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) return { ...s, mood: "waiting" };
      if (message.endsWith("?")) return { ...s, mood: "ask", step: one(message) };
      return prev;
    }
    case "Stop": return { ...s, mood: "done", done: true, step: one(p.last_message ?? p.message) || s.step };
    case "StopFailure": return { ...s, mood: "error", error: true };
    case "SessionEnd": return { ...s, ended: true };
    default: return prev;
  }
}

/** Does this request get a card? Only for a blocking agent, with approval on, not paused, and no other agent card up. */
export function wantsCard(o: { blocking: boolean; approve: boolean; paused: boolean; held: boolean }): boolean {
  return o.blocking && o.approve && !o.paused && !o.held;
}

/** The Y/N key on the card, or null. No modifiers, no repeat, and not before the guard time. */
export function keyWord(e: { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, sinceShownMs: number): "allow" | "deny" | null {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || sinceShownMs < KEY_GUARD_MS) return null;
  const k = e.key.toLowerCase();
  return k === "y" ? "allow" : k === "n" ? "deny" : null;
}
