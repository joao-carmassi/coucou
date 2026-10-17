// Pure rules of Estatísticas de IA: money estimate, period sums, number formats, the view's height.

/** `req` is 0 for days indexed before requests were counted. */
export interface Totals { input: number; output: number; cache_read: number; cache_write: number; reasoning: number; req: number }
export interface DayRow { day: string; tok: Totals; models: Record<string, Totals>; projects: Record<string, number> }
/** The last 30 local days that have usage, oldest first (same shape as Rust). */
export interface Summary { days: DayRow[]; approx: boolean; more: boolean }

export const PRICES_DATE = "2026-10-17";
/** [input, output] USD per million tokens and the cache-read price as a fraction of input. 5-min cache write is 1.25x input. */
type Rate = [number, number, number];

/** Family + version from a model id; date suffixes ("-20250514") are not versions. Old ids put it first ("claude-3-5-haiku"). */
function parseModel(id: string): { fam: string; ver: number } | null {
  const m = id.toLowerCase();
  const old = /claude-(\d)(?:-(\d{1,2})(?!\d))?-(opus|sonnet|haiku)/.exec(m);
  if (old) return { fam: old[3], ver: Number(old[1]) + Number(old[2] ?? 0) / 10 };
  const nw = /(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/.exec(m);
  return nw ? { fam: nw[1], ver: Number(nw[2]) + Number(nw[3] ?? 0) / 10 } : null;
}

// shortcut: Haiku 5.5 is tiered by request size (<=100k tokens 0.10/0.50, else 0.50/2.50); daily totals cannot tell, so the low tier is used. Upgrade by summing per request in Rust.
export function rate(model: string): Rate | null {
  const p = parseModel(model);
  if (!p) return null;
  const { fam, ver } = p;
  switch (fam) {
    case "opus": return ver >= 5.5 ? [4, 20, 0.05] : ver >= 4.5 ? [5, 25, 0.1] : ver >= 3 ? [15, 75, 0.1] : null;
    case "sonnet": return ver >= 5.5 ? [2, 10, 0.05] : ver >= 5 ? [2, 10, 0.1] : ver >= 3 ? [3, 15, 0.1] : null;
    case "haiku": return ver >= 5.5 ? [0.1, 0.5, 0.1] : ver >= 4 && ver < 5 ? [1, 5, 0.1] : ver >= 3.5 && ver < 4 ? [0.8, 4, 0.1] : null;
    default: return ver >= 5.1 ? [10, 50, 0.025] : ver >= 5 ? [10, 50, 0.1] : null; // fable / mythos
  }
}

export function costOf(model: string, t: Totals): number | null {
  const r = rate(model);
  if (!r) return null;
  return (t.input * r[0] + t.output * r[1] + t.cache_read * r[0] * r[2] + t.cache_write * r[0] * 1.25) / 1e6;
}

/** Sum over the models that have a price; `missing` lists the models with tokens and no price. */
export function costTotal(models: readonly [string, Totals][]): { usd: number; partial: boolean; missing: string[] } {
  let usd = 0;
  const missing: string[] = [];
  for (const [m, t] of models) {
    const c = costOf(m, t);
    if (c !== null) usd += c;
    else if (sumOf(t)) missing.push(m);
  }
  return { usd, partial: missing.length > 0, missing };
}

export const ZERO: Totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, req: 0 };
export const sumOf = (t: Totals) => t.input + t.output + t.cache_read + t.cache_write;
const plus = (a: Totals, b: Totals): Totals => ({
  input: a.input + b.input, output: a.output + b.output, cache_read: a.cache_read + b.cache_read,
  cache_write: a.cache_write + b.cache_write, reasoning: a.reasoning + b.reasoning, req: a.req + (b.req ?? 0),
});

/** Local "YYYY-MM-DD", the key Rust writes. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The last `n` day keys, oldest first, ending with `now`'s day. */
export function lastDays(now: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i), 12)));
}

export interface Period {
  tok: Totals;
  models: [string, Totals][];   // biggest first
  projects: [string, number][]; // biggest first
  /** Some day with tokens has no request count (it was indexed by an older version). */
  reqPartial: boolean;
}

/** The given days summed. */
export function period(days: readonly DayRow[], keys: readonly string[]): Period {
  const want = new Set(keys);
  let tok = ZERO, reqPartial = false;
  const models: Record<string, Totals> = {}, projects: Record<string, number> = {};
  for (const d of days) {
    if (!want.has(d.day)) continue;
    tok = plus(tok, d.tok);
    if (sumOf(d.tok) && !d.tok.req) reqPartial = true;
    for (const [m, t] of Object.entries(d.models ?? {})) models[m] = plus(models[m] ?? ZERO, t);
    for (const [p, n] of Object.entries(d.projects ?? {})) projects[p] = (projects[p] ?? 0) + n;
  }
  const big = <T>(list: [string, T][], v: (x: T) => number) => list.sort((a, b) => v(b[1]) - v(a[1]) || a[0].localeCompare(b[0]));
  return { tok, models: big(Object.entries(models), sumOf), projects: big(Object.entries(projects), (n) => n), reqPartial };
}

/** Share of the prompt read from the cache, 0..1; null when nothing was sent. */
export function cacheHit(t: Totals): number | null {
  const prompt = t.input + t.cache_read + t.cache_write;
  return prompt ? t.cache_read / prompt : null;
}

export type Provider = "claude" | "codex";
// shortcut: the source is inferred from the model id (the Claude logs hold only Claude models); upgrade by tagging the source in Rust.
export const providerOf = (model: string): Provider => (/claude|opus|sonnet|haiku|fable|mythos/i.test(model) ? "claude" : "codex");

/** Tokens per provider over the given models. */
export function split(models: readonly [string, Totals][]): Record<Provider, number> {
  const out: Record<Provider, number> = { claude: 0, codex: 0 };
  for (const [m, t] of models) out[providerOf(m)] += sumOf(t);
  return out;
}

/** "claude-opus-4-5-20251101" -> "opus-4-5". */
export const modelName = (id: string): string => id.replace(/^claude-/, "").replace(/-\d{8}$/, "");

const date = (k: string, o: Intl.DateTimeFormatOptions) => new Date(`${k}T12:00:00`).toLocaleDateString("pt-BR", o).replace(/\./g, "");
/** "ter, 10 de mar", or "10 de mar" without the weekday. */
export const dayLabel = (k: string, weekday = true): string =>
  date(k, weekday ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
/** "ter". */
export const weekdayLabel = (k: string): string => date(k, { weekday: "short" });

const one = (n: number) => n.toFixed(1).replace(".", ",");
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${one(n / 1e9)} B`;
  if (n >= 1e6) return `${one(n / 1e6)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil`;
  return String(n);
}

export const fmtUsd = (usd: number) => `US$ ${usd.toFixed(2).replace(".", ",")}`;

export function keepDays(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(365, n) : 90;
}

// Fixed heights of the view's parts (aistats.css), so the island fits its content without measuring. chrome 56 =
// #content padding + header + card border (as sysmon); body padding 12 + 12; head 22.
const FIT_HEAD = 56 + 24 + 22;
/** gap 10, tiles 54, gap 10, (middle), gap 10, foot 16. */
const FIT_BODY = 10 + 54 + 10 + 10 + 16;
export const LIST_MAX = 4;
const ROW_H = 16, ROW_GAP = 4, CHART_H = 96;
export type Tab = "today" | "week" | "month";
/** Island height. "today" holds two lists of `rows` rows (one "nothing" line when 0) under a 14 px heading + 6 gap; the
 *  periods hold the 96 px chart row; `empty` is one message line under the head. */
export function fitHeight(tab: Tab, rows: number, empty = false): number {
  if (empty) return FIT_HEAD + 10 + ROW_H;
  const n = Math.max(1, Math.min(LIST_MAX, rows));
  return FIT_HEAD + FIT_BODY + (tab === "today" ? 20 + n * ROW_H + (n - 1) * ROW_GAP : CHART_H);
}
