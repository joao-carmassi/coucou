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

export interface Cached<T> { key: string; at: number; data: T | null; error: string | null }
export const isFresh = (c: Pick<Cached<unknown>, "at"> | null, ms: number, now: number): boolean => c !== null && now - c.at >= 0 && now - c.at < ms;
