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

/** At the single timeout: nag, or skip because the user was away for a while (that was the break). */
export function shouldNotify(idleMs: number | null): boolean {
  return idleMs === null || idleMs < RESTED_MS;
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

/** Exe list typed in the settings: split on commas/spaces/newlines, lowercase, deduplicated. */
export function parseExcluded(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}
