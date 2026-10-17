// Pure rules of Estatísticas de IA: money estimate, 7-day bars, number formats.

export interface Totals { input: number; output: number; cache_read: number; cache_write: number; reasoning: number }
export interface Summary {
  days: { day: string; tok: Totals }[];
  total: Totals;
  models: [string, Totals][];
  projects: [string, number][];
  approx: boolean;
  more: boolean;
}

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

/** Sum over the models that have a price; `partial` when some model had none. */
export function costTotal(models: readonly [string, Totals][]): { usd: number; partial: boolean } {
  let usd = 0, partial = false;
  for (const [m, t] of models) {
    const c = costOf(m, t);
    if (c === null) partial = true; else usd += c;
  }
  return { usd, partial };
}

export const sumOf = (t: Totals) => t.input + t.output + t.cache_read + t.cache_write;

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The 7 local days ending `now`, with the bar height in percent (the biggest day is 100, a non-empty day at least 4). */
export function weekBars(days: Summary["days"], now: Date): { day: string; tokens: number; pct: number }[] {
  const by = new Map(days.map((d) => [d.day, sumOf(d.tok)]));
  const rows = Array.from({ length: 7 }, (_, i) => {
    const day = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i), 12));
    return { day, tokens: by.get(day) ?? 0, pct: 0 };
  });
  const max = Math.max(...rows.map((r) => r.tokens));
  for (const r of rows) r.pct = r.tokens ? Math.max(4, Math.round((r.tokens / max) * 100)) : 0;
  return rows;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil`;
  return String(n);
}

export const fmtUsd = (usd: number) => `US$ ${usd.toFixed(2)}`;

export function keepDays(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(365, n) : 90;
}
