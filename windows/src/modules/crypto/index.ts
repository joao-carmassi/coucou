// Cripto. Nothing runs in the background. The Cripto view fetches prices and the portfolio only while it is on screen.
// One-line source "price" ("Preços cripto"): while PINNED, one api.interval (60 s, armed only while the island is visible)
// refreshes the prices; the pinned line is also fetched once at start. Not pinned: no timer, no request.
import "./crypto.css";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { cryptoBridge } from "./bridge";
import { priceLine, PRICE_MS } from "./logic";
import { priceKey, CryptoStore, cryptoCfg } from "./store";
import { buildCryptoView } from "./view";

const COIN = "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 7a5 5 0 1 1 0 10a5 5 0 0 1 0-10z";
const store = new CryptoStore(cryptoBridge);
let showStatus: () => void = () => {};

function start(api: IslandApi): Disposer {
  const source = api.status.source("price", { label: "Preços cripto", view: "crypto" });
  let poll: Disposer | null = null;
  showStatus = () => {
    const { coins, fiat } = cryptoCfg(api);
    const c = store.prices;
    const text = c?.key === priceKey(coins, fiat) && c.data ? priceLine(c.data, fiat) : "";
    source.set(text ? { priority: BAND.AMBIENT, text }
      : api.status.pinned("price") ? { priority: BAND.AMBIENT, text: coins.length ? "Cripto: sem dados" : "Cripto: sem moedas", dim: true } : null);
  };
  const refresh = (force = false) => { const { coins, fiat } = cryptoCfg(api); void store.loadPrices(coins, fiat, force); };
  const reconcile = () => {
    const on = api.status.pinned("price");
    showStatus();
    if (on && !poll) {
      poll = api.interval(() => refresh(true), PRICE_MS, { whenVisible: true });
      refresh();
    } else if (!on && poll) { poll(); poll = null; }
  };
  store.onChange = () => { showStatus(); api.island.redraw(); };
  const offs = [
    api.island.onChange(reconcile),
    // The settings window changed coins or fiat (the core updates State after its own listener).
    api.listen("settings-changed", () => { api.timeout(() => { showStatus(); if (poll) refresh(); }, 0); }),
    // The interval sleeps while hidden: catch up on return.
    api.onVisibility((mode) => { if (mode !== "hidden" && poll) refresh(); }),
  ];
  showStatus();
  reconcile();
  return () => {
    offs.forEach((o) => o());
    poll?.();
    poll = null;
    showStatus = () => {};
    store.onChange = () => {};
    store.reset();
    source.dispose();
  };
}

export const cryptoModule: ModuleDef = {
  id: "crypto",
  views: [{
    name: "crypto",
    layout: { height: 300, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildCryptoView(ctx, store, () => showStatus()),
  }],
  tabs: [{ view: "crypto", title: "Cripto", icon: () => svg(COIN, 13), order: 47 }],
  start,
};
