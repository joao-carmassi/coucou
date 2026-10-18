// The module's caches (memory only): prices ~60 s, portfolio ~2 min. Nothing fetches on its own: the view calls load()
// while on screen, and the pinned line calls loadPrices() from its one interval. A reply that a newer request of the
// same kind superseded is dropped.
import { fiatOf, folioShape, FOLIO_MS, isFresh, parseCoins, PRICE_MS } from "./logic";
import type { Cached, CryptoCfg, Fiat, Portfolio, Price } from "./logic";

export const priceKey = (coins: readonly string[], fiat: Fiat) => `${coins.join(",")}|${fiat}`;

export function cryptoCfg(api: { settings<T extends object>(): Readonly<T> }): { coins: string[]; fiat: Fiat; hide: boolean } {
  const c = api.settings<CryptoCfg>();
  return { coins: parseCoins(c.cryptoCoins), fiat: fiatOf(c.cryptoFiat), hide: c.cryptoHideTotal !== false };
}

const settle = <T>(p: Promise<T>) =>
  p.then((data) => ({ data, error: null as string | null }), (err) => ({ data: null as T | null, error: err instanceof Error ? err.message : String(err) }));

interface Src { prices(coins: string[], fiat: Fiat): Promise<Price[]>; portfolio(fiat: Fiat): Promise<Portfolio> }

export class CryptoStore {
  prices: Cached<Price[]> | null = null;
  folio: Cached<Portfolio> | null = null;
  pendingPrices: string | null = null;
  pendingFolio: string | null = null;
  /** First reading of this session, for the change shown: per "COIN|FIAT", and the total for one folioShape. */
  basePrice = new Map<string, { v: number; at: number }>();
  baseTotal: { shape: string; v: number; at: number } | null = null;
  /** Set by the module: a reply landed. */
  onChange: () => void = () => {};
  private seqP = 0;
  private seqF = 0;

  private readonly src: Src;
  constructor(src: Src) { this.src = src; }

  loadPrices(coins: string[], fiat: Fiat, force = false, now = Date.now()): Promise<void> {
    const key = priceKey(coins, fiat);
    if (!coins.length || (!force && (this.pendingPrices === key || (this.prices?.key === key && isFresh(this.prices, PRICE_MS, now))))) return Promise.resolve();
    const seq = ++this.seqP;
    this.pendingPrices = key;
    return settle(this.src.prices(coins, fiat)).then((r) => {
      if (seq !== this.seqP) return;
      this.prices = { key, at: Date.now(), ...r };
      this.pendingPrices = null;
      for (const p of r.data ?? []) {
        const k = `${p.coin}|${fiat}`;
        if (p.price != null && !this.basePrice.has(k)) this.basePrice.set(k, { v: p.price, at: this.prices.at });
      }
      this.onChange();
    });
  }

  loadPortfolio(fiat: Fiat, force = false, now = Date.now()): Promise<void> {
    if (!force && (this.pendingFolio === fiat || (this.folio?.key === fiat && isFresh(this.folio, FOLIO_MS, now)))) return Promise.resolve();
    const seq = ++this.seqF;
    this.pendingFolio = fiat;
    return settle(this.src.portfolio(fiat)).then((r) => {
      if (seq !== this.seqF) return;
      this.folio = { key: fiat, at: Date.now(), ...r };
      this.pendingFolio = null;
      const shape = r.data && folioShape(fiat, r.data);
      if (r.data && shape !== this.baseTotal?.shape) this.baseTotal = { shape: shape as string, v: r.data.total, at: this.folio.at };
      this.onChange();
    });
  }

  /** Drops everything and ignores any reply still on the way (the module stopped). */
  reset(): void {
    this.prices = this.folio = null;
    this.pendingPrices = this.pendingFolio = null;
    this.basePrice.clear();
    this.baseTotal = null;
    this.seqP++;
    this.seqF++;
  }
}
