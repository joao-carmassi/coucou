// Cripto: off = nothing; on without a pin or the view = no command; the view open = one prices + one portfolio request,
// then cache hits; pinned = one 60 s interval armed only while the island is visible; stop drops the line.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { Compact } from "../../src/core/compact";
import { State } from "../../src/core/state";
import { Pin } from "../../src/core/pin";
import { buildCatalog } from "../../src/modules/resolve";

const T = vi.hoisted(() => ({ prices: 0, folios: 0, host: null as null | { sync(): void }, island: null as null | Island }));
vi.mock("../../src/modules/crypto/bridge", () => ({
  cryptoBridge: {
    prices: async (coins: string[]) => { T.prices++; return coins.map((coin) => ({ coin, price: 612340, error: null })); },
    portfolio: async () => { T.folios++; return { total: 100, rows: [{ ccy: "BTC", amount: 1, value: 100, source: "okx" }], errors: [] }; },
    status: async () => ({ coinbase: false, okx: false }),
    wallets: async () => [],
  },
}));

const { cryptoModule: base } = await import("../../src/modules/crypto");
const cryptoModule = { ...base, views: base.views?.map((v) => ({ ...v, build: (ctx: any) => (T.host = v.build(ctx)) })) };
const manifest = {
  id: "crypto", label: "Cripto", default: false, order: 21,
  settingsDefaults: { cryptoCoins: ["BTC", "ETH"], cryptoFiat: "BRL", cryptoOkxRegion: "www", cryptoHideTotal: true },
};
import { CryptoStore, priceKey } from "../../src/modules/crypto/store";
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  document.body.innerHTML = '<div id="root"></div>';
  T.island = new Island(document.getElementById("root")!);
  Registry.init(T.island, [cryptoModule], buildCatalog([manifest], true));
});
afterAll(() => Registry.apply({ crypto: false }));
beforeEach(() => {
  Registry.apply({ crypto: false });
  T.prices = T.folios = 0;
  T.host = null;
  State.settings.pinnedLine = "";
});

describe("crypto module", () => {
  it("off: no line, no request", () => {
    expect(Compact.resolve(0)).toBeNull();
    expect(T.prices + T.folios).toBe(0);
  });

  it("on without a pin or the view: no request", async () => {
    Registry.apply({ crypto: true });
    await tick();
    expect(State.mode).not.toBe("expanded");
    expect(T.prices + T.folios).toBe(0);
  });

  it("opening the view asks once for prices and once for the portfolio; the next sync is a cache hit", async () => {
    Registry.apply({ crypto: true });
    T.island!.open("crypto");
    T.host!.sync();
    T.host!.sync();
    await tick();
    expect([T.prices, T.folios]).toEqual([1, 1]);
    T.host!.sync();
    await tick();
    expect([T.prices, T.folios]).toEqual([1, 1]);
    expect(T.host!.el.textContent).toContain("BTC");
  });

  it("the total is blurred by default (cryptoHideTotal)", async () => {
    Registry.apply({ crypto: true });
    T.island!.open("crypto");
    T.host!.sync();
    await tick();
    T.host!.sync();
    expect(T.host!.el.querySelector(".crypto-total.hide")).not.toBeNull();
  });

  it("pinned: the line shows the prices; stop drops it", async () => {
    Registry.apply({ crypto: true });
    T.island!.open("crypto");
    T.host!.sync();
    await tick();
    Pin.set("crypto.price");
    expect(Compact.resolve(0)?.text).toMatch(/BTC.*612\.340/);
    Registry.apply({ crypto: false });
    expect(Compact.resolve(0)).toBeNull();
  });

  it("pinned: one 60 s interval, none while the island is hidden", async () => {
    vi.useFakeTimers();
    const live = new Set<unknown>();
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = ((fn: () => void, ms: number) => { const id = si(fn, ms); live.add(id); return id; }) as typeof window.setInterval;
    window.clearInterval = ((id: number) => { live.delete(id); ci(id); }) as typeof window.clearInterval;
    try {
      State.settings.pinnedLine = "crypto.price";
      Registry.apply({ crypto: true });
      await vi.advanceTimersByTimeAsync(50);
      expect(T.prices).toBe(1); // once at start
      T.island!.hide();
      await vi.advanceTimersByTimeAsync(100);
      expect(live.size).toBe(0);
      const n = T.prices;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(T.prices).toBe(n); // hidden: nothing polls
    } finally {
      window.setInterval = si;
      window.clearInterval = ci;
      vi.useRealTimers();
    }
  });
});

describe("crypto store", () => {
  it("store: one request per key while fresh or pending; a forced load supersedes; reset drops late replies", async () => {
    let calls = 0;
    const store = new CryptoStore({
      prices: async (coins) => { calls++; return coins.map((coin) => ({ coin, price: 1, error: null })); },
      portfolio: async () => ({ total: 5, rows: [], errors: [] }),
    });
    const p1 = store.loadPrices(["BTC"], "BRL");
    void store.loadPrices(["BTC"], "BRL"); // pending: no second request
    await p1;
    expect(calls).toBe(1);
    await store.loadPrices(["BTC"], "BRL"); // fresh
    expect(calls).toBe(1);
    expect(store.prices?.key).toBe(priceKey(["BTC"], "BRL"));
    await store.loadPrices(["BTC", "ETH"], "BRL"); // other key
    expect(calls).toBe(2);
    await store.loadPrices([], "BRL"); // nothing to ask
    expect(calls).toBe(2);
    const late = store.loadPortfolio("BRL");
    store.reset();
    await late;
    expect(store.folio).toBeNull();
  });

  it("store: a failure is kept (no retry storm) and shows its text", async () => {
    let calls = 0;
    const store = new CryptoStore({ prices: async () => { calls++; throw new Error("offline"); }, portfolio: async () => ({ total: 0, rows: [], errors: [] }) });
    await store.loadPrices(["BTC"], "BRL");
    await store.loadPrices(["BTC"], "BRL");
    expect(calls).toBe(1);
    expect(store.prices?.error).toBe("offline");
  });
});
