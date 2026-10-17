// The Cripto tab: prices of the chosen coins, then the portfolio (total blurred until hover when cryptoHideTotal is on)
// and its rows by asset with their source. Nothing here fetches on its own: sync() asks the store, and does nothing
// unless this view is on screen and the island is expanded. Fixed height, scrolls.
import { clear, h } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { pinButton } from "../../kit/pin";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { amountText, failedText, isPartial, money, SOURCE_LABEL } from "./logic";

import { cryptoCfg, priceKey, type CryptoStore } from "./store";

const clock = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const note = (text: string) => h("div", { class: "crypto-note", text, title: text });

/** `onSync` runs on every visible sync (the module refreshes its status line there). */
export function buildCryptoView(ctx: ViewContext, store: CryptoStore, onSync: () => void): ViewHost {
  let shown = "";
  const when = h("span", { class: "crypto-foot" });
  const again = h("button", { type: "button", class: "link-btn text-link", text: "Atualizar" });
  const head = h("div", { class: "crypto-head pin-room" }, h("span", { class: "crypto-title", text: "Cripto" }), when, h("span", { class: "grow" }), again);
  const panel = h("div", { class: "crypto-panel" });
  const body = h("div", { class: "stack scroll crypto-body" }, head, panel);
  const pin = pinButton(ctx.api, "price");
  const el = view(card(null, body, pin.el));

  const draw = () => {
    const { coins, fiat, hide } = cryptoCfg(ctx.api);
    const p = store.prices?.key === priceKey(coins, fiat) ? store.prices : null;
    const f = store.folio?.key === fiat ? store.folio : null;
    const busy = !!store.pendingPrices || !!store.pendingFolio;
    when.textContent = busy ? "atualizando…" : f ? `às ${clock(f.at)}` : p ? `às ${clock(p.at)}` : "";
    again.disabled = busy;
    clear(panel);

    panel.append(h("div", { class: "crypto-k", text: "Preços" }));
    if (!coins.length) panel.append(note("Escolha as moedas em Configurações › Cripto."));
    else if (p?.data) {
      panel.append(h("div", { class: "crypto-list", role: "list" }, ...p.data.map((x) =>
        h("div", { class: "crypto-row", role: "listitem", title: x.error ?? "" },
          h("span", { class: "crypto-ccy", text: x.coin }),
          h("span", { class: "grow" }),
          h("b", { class: "crypto-val", text: x.price == null ? "–" : money(x.price, fiat) })))));
    } else panel.append(note(p?.error ? `Não foi possível carregar os preços: ${p.error}.` : "Carregando os preços…"));

    panel.append(h("div", { class: "crypto-k", text: "Carteira" }));
    const d = f?.data;
    if (!d) panel.append(note(f?.error ? `Não foi possível carregar a carteira: ${f.error}.` : "Carregando…"));
    else if (!d.rows.length && !d.errors.length) panel.append(note("Conecte uma corretora (somente leitura) ou adicione uma carteira em Configurações › Cripto."));
    else {
      const partial = isPartial(d);
      panel.append(h("div", { class: "crypto-totalrow" },
        h("b", { class: hide ? "crypto-total hide" : "crypto-total", text: money(d.total, fiat), tabindex: hide ? 0 : undefined }),
        partial && h("span", { class: "crypto-partial", text: "parcial", title: d.errors.length ? `Falhou: ${failedText(d.errors)}` : "Alguns ativos estão sem preço" })));
      if (d.errors.length) panel.append(note(`Sem resposta de: ${failedText(d.errors)}.`));
      panel.append(h("div", { class: "crypto-list", role: "list" }, ...d.rows.map((r) =>
        h("div", { class: "crypto-row", role: "listitem" },
          h("span", { class: "crypto-ccy", text: r.ccy }),
          h("span", { class: "crypto-src", text: SOURCE_LABEL[r.source] }),
          h("span", { class: "grow" }),
          h("span", { class: hide ? "crypto-amt hide" : "crypto-amt", text: amountText(r.amount) }),
          h("b", { class: hide ? "crypto-val hide" : "crypto-val", text: r.value == null ? "–" : money(r.value, fiat) })))));
    }
  };
  const update = () => {
    const { coins, fiat } = cryptoCfg(ctx.api);
    void store.loadPrices(coins, fiat);
    void store.loadPortfolio(fiat);
    const p = store.prices, f = store.folio;
    const sig = JSON.stringify([coins, fiat, cryptoCfg(ctx.api).hide, p?.key, p?.at, p?.error, f?.key, f?.at, f?.error, store.pendingPrices, store.pendingFolio]);
    if (sig !== shown) { shown = sig; draw(); }
  };
  again.addEventListener("click", () => {
    const { coins, fiat } = cryptoCfg(ctx.api);
    void store.loadPrices(coins, fiat, true);
    void store.loadPortfolio(fiat, true);
    update();
  });

  return {
    el,
    get height() { return 300; },
    sync() {
      // Nothing is fetched or touched while the view is hidden or the island is folded.
      if (ctx.api.island.view() !== "crypto" || ctx.api.island.mode() !== "expanded") return;
      onSync();
      pin.sync();
      update();
    },
  };
}
