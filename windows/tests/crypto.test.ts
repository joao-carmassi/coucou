import test from "node:test";
import assert from "node:assert/strict";
import {
  amountText, changePct, coinChange, changeText, failedText, fiatOf, fitHeight, folioShape, isFresh, isPartial, linkState, money, parseCoins, priceLine, PRICE_MS,
} from "../src/modules/crypto/logic.ts";

test("change this session: percent, text and direction; no base, no number", () => {
  assert.equal(changePct(110, 100), 10);
  assert.equal(changePct(5, null), null);
  assert.equal(changePct(5, 0), null);
  assert.deepEqual(changeText(1.234), { text: "+1,2%", dir: "up" });
  assert.deepEqual(changeText(-0.44), { text: "−0,4%", dir: "down" });
  assert.deepEqual(changeText(0.01), { text: "0,0%", dir: "flat" });
});

test("coin change: the 24 h value wins, else the session base, else none", () => {
  assert.deepEqual(coinChange({ price: 110, change24h: -2.5 }, 100), { pct: -2.5, is24h: true });
  assert.deepEqual(coinChange({ price: 110, change24h: 0 }, 100), { pct: 0, is24h: true });
  assert.deepEqual(coinChange({ price: 110, change24h: null }, 100), { pct: 10, is24h: false });
  assert.deepEqual(coinChange({ price: 110 }, undefined), { pct: null, is24h: false });
});

test("source state: off, unknown, error, empty, ok with its sum; the shape changes with a new or failed source", () => {
  const p = { total: 30, rows: [{ ccy: "BTC", amount: 1, value: 20, source: "okx" as const }, { ccy: "ETH", amount: 1, value: 10, source: "okx" as const }], errors: ["coinbase"] };
  assert.equal(linkState("coinbase", false, p).state, "off");
  assert.equal(linkState("coinbase", true, p).state, "error");
  assert.equal(linkState("okx", null, p).state, "unknown");
  assert.equal(linkState("okx", true, null).state, "unknown");
  assert.deepEqual(linkState("okx", true, p), { state: "ok", value: 30 });
  assert.equal(linkState("wallet", true, p).state, "empty");
  assert.equal(folioShape("BRL", p), folioShape("BRL", { ...p, total: 99, rows: [...p.rows].reverse() }));
  assert.notEqual(folioShape("BRL", p), folioShape("BRL", { ...p, errors: [] }));
});

test("fitted height: a note, the rows, never above 320", () => {
  assert.equal(fitHeight("note"), 128);
  assert.equal(fitHeight("prices", 2), 102 + 10 + 20 + 42);
  assert.equal(fitHeight("folio", 1), 102 + 10 + 34 + 10 + 40 + 10 + 20);
  assert.equal(fitHeight("folio", 20), 320);
});

const nb = (s: string) => s.replace(/\s/g, " ");

test("parseCoins: upper case, valid, unique, at most 8", () => {
  assert.deepEqual(parseCoins("btc, eth;BTC x  sol"), ["BTC", "ETH", "SOL"]);
  assert.deepEqual(parseCoins(["btc", "../x", "A", "usdt"]), ["BTC", "USDT"]);
  assert.deepEqual(parseCoins(null), []);
  assert.equal(parseCoins("a1 b2 c3 d4 e5 f6 g7 h8 i9 j0").length, 8);
});

test("fiat falls back to BRL", () => {
  assert.equal(fiatOf("USD"), "USD");
  assert.equal(fiatOf("GBP"), "BRL");
  assert.equal(fiatOf(undefined), "BRL");
});

test("money and the pinned price line", () => {
  assert.match(nb(money(612340.12, "BRL")), /^R\$ 612\.340$/);
  assert.match(nb(money(12.5, "BRL")), /^R\$ 12,50$/);
  assert.equal(
    nb(priceLine([{ coin: "BTC", price: 612340, error: null }, { coin: "XYZ", price: null, error: "x" }, { coin: "ETH", price: 21300, error: null }], "BRL")),
    "BTC R$ 612.340 · ETH R$ 21.300",
  );
  assert.equal(priceLine([], "BRL"), "");
  assert.equal(amountText(0.12345678901), "0,12345679");
});

test("partial total: a failed source or an unpriced row", () => {
  assert.equal(isPartial({ rows: [{ ccy: "BTC", amount: 1, value: 10, source: "okx" }], errors: [] }), false);
  assert.equal(isPartial({ rows: [], errors: ["coinbase"] }), true);
  assert.equal(isPartial({ rows: [{ ccy: "XYZ", amount: 1, value: null, source: "wallet" }], errors: [] }), true);
  assert.equal(failedText(["coinbase", "wallet"]), "Coinbase, Carteira");
});

test("cache freshness", () => {
  assert.equal(isFresh({ at: 1000 }, PRICE_MS, 1000 + PRICE_MS - 1), true);
  assert.equal(isFresh({ at: 1000 }, PRICE_MS, 1000 + PRICE_MS), false);
  assert.equal(isFresh(null, PRICE_MS, 0), false);
});
