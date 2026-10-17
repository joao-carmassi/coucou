import test from "node:test";
import assert from "node:assert/strict";
import { amountText, failedText, fiatOf, isFresh, isPartial, money, parseCoins, priceLine, PRICE_MS } from "../src/modules/crypto/logic.ts";

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
