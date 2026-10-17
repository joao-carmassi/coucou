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
/** USD per million tokens (input, output). Cache read costs 0.1x input, cache write 1.25x. Estimate only. */
function rate(model: string): [number, number] | null {
  const m = model.toLowerCase();
  if (m.includes("opus")) {
    const minor = /opus-4-(\d+)/.exec(m);
    return minor && Number(minor[1]) >= 5 ? [5, 25] : [15, 75];
  }
  if (m.includes("sonnet")) return [3, 15];
  if (m.includes("haiku")) return [1, 5];
  return null; // unknown model: no cost, never zero
}

export function costOf(model: string, t: Totals): number | null {
  const r = rate(model);
  if (!r) return null;
  return (t.input * r[0] + t.output * r[1] + t.cache_read * r[0] * 0.1 + t.cache_write * r[0] * 1.25) / 1e6;
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
