// Pure helpers: line text, reset text and the 90 % notice rule. No DOM, no Tauri (Node tests load this file).
import type { AgentUsage, UsageWindow } from "../agents/api";

export const NOTICE_PCT = 90;
export const CLAUDE_MS = 5 * 60_000;
const NAMES: Record<string, string> = { codex: "Codex", claude: "Claude" };

export const agentName = (agent: string) => NAMES[agent] ?? agent;

const pct = (n: number) => `${Math.round(n)}%`;

/** A window whose reset time already passed shows no number: the counter rolled over after the last read. */
export const live = (w: UsageWindow, now: number) => w.usedPct != null && !(w.resetsAt != null && w.resetsAt <= now);

/** "5 h 17%", "sem. 4%", "–" when unknown or rolled over. */
export function windowText(w: UsageWindow, now: number): string {
  const label = w.label === "semana" ? "sem." : w.label;
  return `${label} ${live(w, now) ? pct(w.usedPct as number) : "–"}`;
}

/** "Codex 5 h 17% · sem. 4%". Empty when the agent has no windows. */
export function agentText(u: AgentUsage, now: number): string {
  return u.windows.length ? `${agentName(u.agent)} ${u.windows.map((w) => windowText(w, now)).join(" · ")}` : "";
}

/** The pinned line: Codex in full, Claude's 5 h window only (when the network opt-in gave a fresh answer). */
export function lineText(codex: AgentUsage | null, claude: AgentUsage | null, now: number): string | null {
  const c = claude && !claude.error ? agentText({ ...claude, windows: claude.windows.filter((w) => w.label === "5 h") }, now) : "";
  const parts = [codex ? agentText(codex, now) : "", c].filter(Boolean);
  return parts.length ? parts.join(" | ") : null;
}

/** "zera em 2 h 10 min", "zera em 3 d 4 h"; "" when unknown or past. */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt == null || resetsAt <= now) return "";
  const min = Math.ceil((resetsAt - now) / 60_000);
  if (min < 60) return `zera em ${min} min`;
  if (min < 2880) return `zera em ${Math.floor(min / 60)} h ${min % 60} min`;
  return `zera em ${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
}

/** Bar colour: calm under 70 %, amber from 70 %, red from 90 % (where the notice fires). */
export const level = (p: number): "calm" | "warm" | "high" => (p >= NOTICE_PCT ? "high" : p >= 70 ? "warm" : "calm");

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Row label: "5 horas", "Semana", "Opus · semana" (weekly_opus), "Sonnet 5"; "N min" as is. */
export function windowLabel(label: string): string {
  if (label === "5 h") return "5 horas";
  if (label === "semana") return "Semana";
  const s = label.replace(/[_-]+/g, " ").trim();
  const model = /opus|sonnet|haiku/i.exec(s)?.[0];
  return model && /week|seven/i.test(s) ? `${cap(model.toLowerCase())} · semana` : cap(s);
}

export const noticeKey = (agent: string, label: string) => `plan-${agent}-${label}`;

/** Windows that crossed 90 % and were not announced for their current reset. Records what it returns in `seen`. */
export function dueNotices(u: AgentUsage, seen: Map<string, number>, now: number): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const w of u.windows) {
    if (!live(w, now) || (w.usedPct as number) < NOTICE_PCT) continue;
    const key = noticeKey(u.agent, w.label);
    const stamp = w.resetsAt ?? 0;
    if (seen.get(key) === stamp) continue;
    seen.set(key, stamp);
    out.push({ key, text: `${agentName(u.agent)}: ${w.label === "semana" ? "limite semanal" : `limite de ${w.label}`} em ${pct(w.usedPct as number)}` });
  }
  return out;
}

/** Claude's answer is reused for 5 minutes (errors included), as on the Rust side. */
export const claudeFresh = (at: number | null, now: number) => at != null && now - at < CLAUDE_MS;

// Fixed heights of the view's parts (planusage.css), so the island fits its content without measuring. chrome 56 =
// #content padding + header + card border (as eyecare); body padding 12 + 12; head row 22.
const FIT_BASE = 56 + 24 + 22;
// Per block: gap 10 above, border 2, padding 8 + 8, block head 14, gap 8; then lines of 16 with 6 between.
const BLOCK = 10 + 2 + 16 + 14 + 8, LINE = 16, LINE_GAP = 6;
/** Island height for the blocks shown: `lines` per block (a bar row or a note line, at least 1). Scrolls only past `max`. */
export function fitPlan(lines: number[], max = 320): { height: number; scroll: boolean } {
  const need = FIT_BASE + lines.reduce((a, n) => a + BLOCK + Math.max(1, n) * LINE + (Math.max(1, n) - 1) * LINE_GAP, 0);
  return { height: Math.min(max, need), scroll: need > max };
}
