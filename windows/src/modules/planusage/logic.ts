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

/** "reinicia em 2 h 10 min", "reinicia em 3 d 4 h"; "" when unknown or past. */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt == null || resetsAt <= now) return "";
  const min = Math.ceil((resetsAt - now) / 60_000);
  if (min < 60) return `reinicia em ${min} min`;
  if (min < 2880) return `reinicia em ${Math.floor(min / 60)} h ${min % 60} min`;
  return `reinicia em ${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
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

/** Island height for what the view shows: `windows` = bar rows per block (0 = a one-line note instead). Scrolls only past `max`. */
export function fitPlan(blocks: number[], max = 320, chrome = 56, pad = 14): { height: number; scroll: boolean } {
  const parts = [...blocks.map((w) => (w ? 14 + w * 35 : 31)), 30]; // block = title + rows (or title + note); last = "Atualizar"
  const need = chrome + 2 * pad + parts.reduce((a, b) => a + b, 0) + 10 * (parts.length - 1);
  return { height: Math.min(max, Math.max(160, need)), scroll: need > max };
}
