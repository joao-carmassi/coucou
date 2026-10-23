// Pure rules of the Pausas module: which break comes next, whether to nag, how usage is summed and shown.

export type BreakKind = "eyes" | "stretch" | "water";
export interface BreakDef { text: string; emote: "wink" | "yawn" | "happy"; label: string }

export const BREAKS: Record<BreakKind, BreakDef> = {
  eyes: { label: "Olhos", text: "Descanse os olhos: olhe algo a 6 m por 20 s", emote: "wink" },
  stretch: { label: "Alongar", text: "Hora de alongar: levante e estique o corpo", emote: "yawn" },
  water: { label: "Água", text: "Beba um pouco de água", emote: "happy" },
};
export const KIND_ORDER = Object.keys(BREAKS) as BreakKind[];

export const MIN_INTERVAL = 5, MAX_INTERVAL = 60;
/** Idle at least this long when the timeout fires: the user already took a real break. */
export const RESTED_MS = 5 * 60_000;

/** Minutes between reminders; 0 = reminders off. Anything else is clamped to 5..60. */
export function intervalMin(v: unknown): number {
  const n = Math.floor(Number(v));
  return !Number.isFinite(n) || n <= 0 ? 0 : Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
}

/** The enabled kinds, in canonical order, ignoring unknown names. */
export function enabledKinds(v: unknown): BreakKind[] {
  const set = new Set(Array.isArray(v) ? v : []);
  return KIND_ORDER.filter((k) => set.has(k));
}

/** The n-th reminder rotates through the enabled kinds; null when none is enabled. */
export function pickKind(kinds: readonly BreakKind[], n: number): BreakKind | null {
  return kinds.length ? kinds[n % kinds.length] : null;
}

/** Wait this long before asking again when the user is busy (full-screen, game, call). */
export const RETRY_MS = 2 * 60_000;
/** An unanswered card closes after this long, and the round counts as not taken. */
export const ASK_MS = 2 * 60_000;

/** What a reminder does: wait (quiet), skip (same absence as the last round), count as taken (already away), or ask. */
export type Round = "wait" | "skip" | "taken" | "ask";
export function roundOf(idleMs: number | null, quiet: boolean, intervalMs: number): Round {
  if (quiet) return "wait";
  const idle = idleMs ?? 0;
  // Already rested at the last round (one interval ago): that round counted this absence.
  return idle >= intervalMs + RESTED_MS ? "skip" : idle >= RESTED_MS ? "taken" : "ask";
}

export type Days = Record<string, Record<string, number>>;

/** Local "YYYY-MM-DD", the same key the Rust side writes. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The last `n` day keys, oldest first, ending with `now`'s day. */
export function lastDays(now: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i))));
}

export const dayTotal = (d: Record<string, number> | undefined): number => Object.values(d ?? {}).reduce((a, b) => a + b, 0);

/** Apps of the given days summed, biggest first, at most `n`. */
export function topApps(days: Days, keys: readonly string[], n: number): { exe: string; secs: number }[] {
  const sum: Record<string, number> = {};
  for (const k of keys) for (const [exe, s] of Object.entries(days[k] ?? {})) sum[exe] = (sum[exe] ?? 0) + s;
  return Object.entries(sum).map(([exe, secs]) => ({ exe, secs })).sort((a, b) => b.secs - a.secs || a.exe.localeCompare(b.exe)).slice(0, n);
}

/** "2 h 05", "14 min", "< 1 min". */
export function fmtDur(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 1) return "< 1 min";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** "code.exe" -> "code". */
export const appName = (exe: string): string => exe.replace(/\.exe$/i, "");

/** Reminder rounds per local day as [due, taken], and the unix ms of the last break taken (0 = none). Same shape as Rust. */
export interface Breaks { days: Record<string, [number, number]>; last: number }
export const NO_BREAKS: Breaks = { days: {}, last: 0 };

/** [due, taken] summed over the given days. */
export function breaksOf(b: Breaks, keys: readonly string[]): [number, number] {
  return keys.reduce<[number, number]>((a, k) => [a[0] + (b.days[k]?.[0] ?? 0), a[1] + (b.days[k]?.[1] ?? 0)], [0, 0]);
}

/** Days in a row with at least one break, ending today (or yesterday, while today has none yet). */
export function streak(b: Breaks, now: Date): number {
  const taken = (i: number) => (b.days[dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))]?.[1] ?? 0) > 0;
  const from = taken(0) ? 0 : 1;
  let n = 0;
  while (n < 366 && taken(from + n)) n++;
  return n;
}

/** "agora", "há 42 min", "há 2 h 05", "há 3 dias"; null when no break was seen. */
export function since(lastMs: number, nowMs: number): string | null {
  if (!lastMs) return null;
  const s = Math.max(0, (nowMs - lastMs) / 1000);
  if (s < 60) return "agora";
  if (s < 86_400) return `há ${fmtDur(s)}`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "há 1 dia" : `há ${d} dias`;
}

const date = (k: string, o: Intl.DateTimeFormatOptions) => new Date(`${k}T12:00:00`).toLocaleDateString("pt-BR", o).replace(/\./g, "");
/** "ter, 10 de mar", or "10 de mar" without the weekday. */
export const dayLabel = (k: string, weekday = true): string =>
  date(k, weekday ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
/** "ter". */
export const weekdayLabel = (k: string): string => date(k, { weekday: "short" });

// Fixed heights of the view's parts (eyecare.css), so the island fits its content without measuring. chrome 56 =
// #content padding + header + card border (as sysmon); body padding 12 + 12; head 22; tiles 54; two gaps of 10.
const FIT_BASE = 56 + 24 + 22 + 10 + 54 + 10;
const CHART_H = 96, ROW_H = 16, ROW_GAP = 4;
/** Island height for a tab: "today" lists `rows` apps (or one "nothing yet" line) under a 14 px heading + 6 gap; "week" holds the chart. */
export function fitHeight(tab: "today" | "week", rows: number): number {
  return FIT_BASE + (tab === "week" ? CHART_H : 20 + (rows ? rows * ROW_H + (rows - 1) * ROW_GAP : ROW_H));
}

/** Exe list typed in the settings: split on commas/spaces/newlines, lowercase, deduplicated. */
export function parseExcluded(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}
