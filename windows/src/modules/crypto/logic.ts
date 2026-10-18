// Cripto: formatting, parsing and cache rules. Pure (type imports only), so node tests load it directly.

export type Fiat = "BRL" | "USD" | "EUR";
export type Source = "coinbase" | "okx" | "wallet";
export interface Price { coin: string; price: number | null; error: string | null }
export interface Row { ccy: string; amount: number; value: number | null; source: Source }
export interface Portfolio { total: number; rows: Row[]; errors: string[] }
export interface Wallet { slot: number; kind: string; short: string }
export interface Status { coinbase: boolean; okx: boolean }

/** Settings keys of this module (manifest settingsDefaults). */
export interface CryptoCfg { cryptoCoins: unknown; cryptoFiat: unknown; cryptoOkxRegion: unknown; cryptoHideTotal: unknown }

export const FIATS: readonly Fiat[] = ["BRL", "USD", "EUR"];
export const REGIONS = [["www", "Global"], ["us", "EUA"], ["eea", "Europa (EEA)"]] as const;
export const MAX_COINS = 8;
/** Prices are fetched at most this often; a failure is kept this long too (no retry storm). */
export const PRICE_MS = 60_000;
export const FOLIO_MS = 120_000;

export const SOURCE_LABEL: Record<Source, string> = { coinbase: "Coinbase", okx: "OKX", wallet: "Carteira" };

export const fiatOf = (v: unknown): Fiat => (FIATS as readonly unknown[]).includes(v) ? (v as Fiat) : "BRL";

/** "btc, eth, BTC, x" -> ["BTC", "ETH"]: upper case, 2..10 letters or digits, no repeats, at most 8. */
export function parseCoins(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const c of raw.map((x) => x.trim().toUpperCase())) if (/^[A-Z0-9]{2,10}$/.test(c) && !out.includes(c)) out.push(c);
  return out.slice(0, MAX_COINS);
}

export function money(v: number, fiat: Fiat): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: fiat, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
}

/** A coin amount: up to 8 decimals, no trailing zeros. */
export function amountText(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 8 });
}

/** "BTC R$ 612.340 · ETH R$ 21.300"; a coin without a price is left out. */
export function priceLine(list: readonly Price[], fiat: Fiat): string {
  return list.filter((p) => p.price != null).map((p) => `${p.coin} ${money(p.price as number, fiat)}`).join(" · ");
}

/** True when a source failed or a row has no price: the total is then only part of the story. */
export const isPartial = (p: Pick<Portfolio, "rows" | "errors">): boolean => p.errors.length > 0 || p.rows.some((r) => r.value == null);

export const failedText = (errors: readonly string[]): string =>
  errors.map((e) => SOURCE_LABEL[e as Source] ?? e).join(", ");

/** Percent change from `base` to `v`; null without a usable base. */
export const changePct = (v: number | null, base: number | null | undefined): number | null =>
  v == null || base == null || !(base > 0) ? null : ((v - base) / base) * 100;

/** "+1,2%", "−0,4%", "0,0%" and its direction (under 0.05 % is flat). */
export function changeText(p: number): { text: string; dir: "up" | "down" | "flat" } {
  const dir = Math.abs(p) < 0.05 ? "flat" : p > 0 ? "up" : "down";
  const n = Math.abs(p).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return { text: dir === "flat" ? "0,0%" : `${dir === "up" ? "+" : "−"}${n}%`, dir };
}

/** What the total is made of: a new or failed source re-bases the change instead of showing a jump. */
export const folioShape = (fiat: Fiat, p: Portfolio): string =>
  `${fiat}|${p.rows.map((r) => `${r.source}:${r.ccy}`).sort().join(",")}|${[...p.errors].sort().join(",")}`;

/** How one source reads: "off" not connected (no wallet), "ok" with balances, "empty" connected without, "error"
 *  failed this time, "unknown" not read yet. `value` is the sum of its priced rows. */
export type LinkState = "off" | "ok" | "empty" | "error" | "unknown";
export function linkState(src: Source, linked: boolean | null, p: Portfolio | null): { state: LinkState; value: number } {
  const rows = p ? p.rows.filter((r) => r.source === src) : [];
  const value = rows.reduce((a, r) => a + (r.value ?? 0), 0);
  if (linked === false) return { state: "off", value };
  if (p?.errors.includes(src)) return { state: "error", value };
  if (linked === null || !p) return { state: "unknown", value };
  return { state: rows.length ? "ok" : "empty", value };
}

export interface Cached<T> { key: string; at: number; data: T | null; error: string | null }
export const isFresh = (c: Pick<Cached<unknown>, "at"> | null, ms: number, now: number): boolean => c !== null && now - c.at >= 0 && now - c.at < ms;

// Fixed heights of the view's parts (crypto.css), so the island fits its content without measuring. chrome 56 =
// #content padding + header + card border (as eyecare); body padding 12 + 12; head row 22; 10 between the panel's parts.
const FIT_BASE = 56 + 24 + 22;
const NOTE = 16, HERO = 34, LINKS = 40, SEC_HEAD = 14 + 6, ROW = 20, ROW_GAP = 2;
const listH = (n: number) => (n ? n * ROW + (n - 1) * ROW_GAP : NOTE);
/** Island height: "folio" (hero, sources, `rows` asset rows or a note), "prices" (a heading and `rows` coins or a note),
 *  or one note. Never above 320 (PANEL_H): past that the body scrolls. */
export function fitHeight(tab: "folio" | "prices" | "note", rows = 0): number {
  const need = FIT_BASE + 10 + (tab === "note" ? NOTE : tab === "folio" ? HERO + 10 + LINKS + 10 + listH(rows) : SEC_HEAD + listH(rows));
  return Math.min(320, need);
}
