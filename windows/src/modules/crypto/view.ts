// The Cripto tab, two tabs: "Carteira" (the total with its change this session, one tile per source with its state, the
// rows by asset) and "Preços" (one row per chosen coin with its change this session). With cryptoHideTotal on, every
// figure of the portfolio stays blurred until hover or focus. Nothing here fetches on its own: sync() asks the store
// (and reads which sources are linked, a local call), and does nothing unless this view is on screen and the island is
// expanded. Heights are fixed (logic.ts fitHeight adds them up); past 320 the body scrolls.
import { clear, h, replay } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { pinButton } from "../../kit/pin";
import { COLOR, wear } from "../../kit/palette";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { cryptoBridge } from "./bridge";
import {
  amountText, changePct, changeText, failedText, fitHeight, isPartial, linkState, money, SOURCE_LABEL,
  type Fiat, type LinkState, type Portfolio, type Source, type Status,
} from "./logic";
import { cryptoCfg, priceKey, type CryptoStore } from "./store";

type Tab = "folio" | "prices";
const clock = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const note = (text: string, cls = "") => h("div", { class: `crypto-note${cls ? ` ${cls}` : ""}`, text, title: text });
const SETUP = "Configurações › Cripto";

// A coin's mark colour: the well-known ones by their brand's hue, the rest picked from the name (stable between reads).
const TINT: Record<string, string> = {
  BTC: COLOR.amber, ETH: COLOR.indigo, SOL: COLOR.cyan, USDT: COLOR.green, USDC: COLOR.blue, BNB: COLOR.amber,
  DOGE: COLOR.amber, XRP: COLOR.dim, ADA: COLOR.blue, LTC: COLOR.dim, DAI: COLOR.amber, POL: COLOR.indigo,
};
const CYCLE = [COLOR.blue, COLOR.cyan, COLOR.indigo, COLOR.green, COLOR.amber];
function mark(ccy: string): HTMLElement {
  const el = h("span", { class: "crypto-mark", text: ccy.charAt(0), "aria-hidden": "true" });
  wear(el, TINT[ccy] ?? CYCLE[[...ccy].reduce((a, c) => a + c.charCodeAt(0), 0) % CYCLE.length]);
  return el;
}
/** "+1,2%" coloured by direction; "–" without a base. */
function change(p: number | null, since: number | undefined, hide = false): HTMLElement {
  const c = p == null ? null : changeText(p);
  return h("span", {
    class: `crypto-chg ${c?.dir ?? "none"}${hide ? " hide" : ""}`, text: c?.text ?? "–",
    title: c && since ? `Variação desde ${clock(since)} (primeira leitura desta sessão)` : "Sem leitura anterior nesta sessão",
  });
}
const blur = (cls: string, hide: boolean) => (hide ? `${cls} hide` : cls);

const LINK_TEXT: Record<LinkState, string> = { off: "não conectada", ok: "conectada", empty: "sem saldo", error: "erro ao ler", unknown: "verificando…" };
/** One source tile: name, a dot and its state, and its share of the total when it has balances. */
function linkTile(src: Source, linked: boolean | null, wallets: number | null, d: Portfolio | null, fiat: Fiat, hide: boolean): HTMLElement {
  const { state, value } = linkState(src, linked, d);
  let text = LINK_TEXT[state];
  if (src === "wallet") text = state === "off" ? "nenhuma" : state === "ok" ? `${wallets} ${wallets === 1 ? "carteira" : "carteiras"}` : text;
  const tip = state === "off" ? `Conecte em ${SETUP} (somente leitura).` : state === "error" ? `${SOURCE_LABEL[src]} não respondeu nesta leitura; o total está parcial.` : undefined;
  return h("div", { class: `crypto-link ${state}`, title: tip },
    h("span", { class: "crypto-k", text: src === "wallet" ? "Carteiras" : SOURCE_LABEL[src] }),
    h("span", { class: "crypto-link-line" },
      h("i", { class: "crypto-dot" }),
      h("span", { class: "crypto-link-text", text }),
      state === "ok" && h("b", { class: blur("crypto-link-val", hide), text: money(value, fiat) })));
}

/** `onSync` runs on every visible sync (the module refreshes its status line there). */
export function buildCryptoView(ctx: ViewContext, store: CryptoStore, onSync: () => void): ViewHost {
  let tab: Tab = "folio";
  let shown = "";
  let fitted = fitHeight("note");
  // Which sources are linked: read (locally) once per portfolio reading. null = not read yet or unreadable.
  let links: { status: Status | null; wallets: number | null } = { status: null, wallets: null };
  let linksFor: number | null = null;

  const when = h("span", { class: "crypto-foot" });
  const again = h("button", { type: "button", class: "link-btn text-link", text: "Atualizar" });
  const tabBtn = (t: Tab, text: string) => h("button", { type: "button", role: "tab", text, onclick: () => { if (tab === t) return; tab = t; update(); replay(panel, "fade"); } });
  const tabs: Record<Tab, HTMLButtonElement> = { folio: tabBtn("folio", "Carteira"), prices: tabBtn("prices", "Preços") };
  const seg = h("div", { class: "seg crypto-tabs", role: "tablist", "aria-label": "Cripto" }, tabs.folio, tabs.prices);
  const head = h("div", { class: "crypto-head pin-room" }, h("span", { class: "crypto-title", text: "Cripto" }), when, h("span", { class: "grow" }), again, seg);
  const panel = h("div", { class: "crypto-panel", role: "tabpanel" });
  const body = h("div", { class: "stack scroll crypto-body" }, head, panel);
  const pin = pinButton(ctx.api, "price");
  const el = view(card(null, body, pin.el)); // pin: sibling of the scrolling body, inside the positioned card

  /** "Carteira": the parts and the rows they take (0 for a note). */
  const folioPanel = (fiat: Fiat, hide: boolean): [HTMLElement[], number] => {
    const f = store.folio?.key === fiat ? store.folio : null;
    const d = f?.data ?? null;
    const st = links.status;
    const linked = { coinbase: st ? st.coinbase : null, okx: st ? st.okx : null, wallet: links.wallets == null ? null : links.wallets > 0 };
    const nothing = st && !st.coinbase && !st.okx && links.wallets === 0;
    const base = store.baseTotal;
    const hero = h("div", { class: "crypto-hero" },
      h("b", { class: blur("crypto-total", hide), text: d ? money(d.total, fiat) : "–", tabindex: hide && d ? 0 : undefined, title: hide ? "Passe o mouse para ver" : undefined }),
      d && base ? change(changePct(d.total, base.v), base.at, hide) : null,
      d && isPartial(d) && h("span", {
        class: "crypto-tag warn", text: "parcial",
        title: d.errors.length ? `Sem resposta de: ${failedText(d.errors)}.` : `Sem preço: ${d.rows.filter((r) => r.value == null).map((r) => r.ccy).join(", ")}.`,
      }),
      h("span", { class: "grow" }),
      h("span", { class: "crypto-foot", text: `total em ${fiat}` }));
    const tiles = h("div", { class: "crypto-links" },
      ...(["coinbase", "okx", "wallet"] as const).map((s) => linkTile(s, linked[s], links.wallets, d, fiat, hide)));
    let rest: HTMLElement;
    let rows = 0;
    if (!d) rest = note(f?.error ? `Não foi possível carregar a carteira: ${f.error}.` : "Carregando a carteira…", f?.error ? "err" : "");
    else if (!d.rows.length) {
      rest = nothing ? note(`Nada conectado. Conecte a Coinbase ou a OKX (somente leitura) ou adicione uma carteira em ${SETUP}.`)
        : d.errors.length ? note(`Sem resposta de: ${failedText(d.errors)}. Tente Atualizar.`, "err")
        : note("Nenhum saldo encontrado nas contas conectadas.");
    } else {
      rows = d.rows.length;
      rest = h("div", { class: "crypto-list", role: "list", "aria-label": "Ativos" }, ...d.rows.map((r) =>
        h("div", { class: "crypto-row", role: "listitem", title: r.value == null ? `${r.ccy}: sem preço em ${fiat}` : undefined },
          mark(r.ccy),
          h("span", { class: "crypto-ccy", text: r.ccy }),
          h("span", { class: "crypto-src", text: SOURCE_LABEL[r.source] }),
          h("span", { class: "grow" }),
          h("span", { class: blur("crypto-amt", hide), text: amountText(r.amount) }),
          h("b", { class: blur(r.value == null ? "crypto-val none" : "crypto-val", hide), text: r.value == null ? "sem preço" : money(r.value, fiat) }))));
    }
    return [[hero, tiles, rest], rows];
  };

  /** "Preços": a heading and one row per coin (or a note). */
  const pricesPanel = (coins: string[], fiat: Fiat): [HTMLElement[], number] => {
    const p = store.prices?.key === priceKey(coins, fiat) ? store.prices : null;
    const since = Math.min(...coins.map((c) => store.basePrice.get(`${c}|${fiat}`)?.at ?? Infinity));
    const sec = h("div", { class: "crypto-sec-head" }, h("span", { class: "crypto-k", text: `Preços em ${fiat}` }),
      h("span", { class: "crypto-foot", text: Number.isFinite(since) ? `variação desde ${clock(since)}` : "" }));
    if (!coins.length) return [[sec, note(`Escolha as moedas em ${SETUP}.`)], 0];
    if (!p?.data) return [[sec, note(p?.error ? `Não foi possível carregar os preços: ${p.error}.` : "Carregando os preços…", p?.error ? "err" : "")], 0];
    return [[sec, h("div", { class: "crypto-list", role: "list", "aria-label": "Preços" }, ...p.data.map((x) => {
      const base = store.basePrice.get(`${x.coin}|${fiat}`);
      return h("div", { class: "crypto-row", role: "listitem", title: x.error ? `${x.coin}: ${x.error}` : undefined },
        mark(x.coin),
        h("span", { class: "crypto-ccy", text: x.coin }),
        h("span", { class: "grow" }),
        x.price == null ? h("span", { class: "crypto-chg none", text: "sem preço" }) : change(changePct(x.price, base?.v), base?.at),
        h("b", { class: x.price == null ? "crypto-val none" : "crypto-val", text: x.price == null ? "–" : money(x.price, fiat) }));
    }))], p.data.length];
  };

  const draw = () => {
    const { coins, fiat, hide } = cryptoCfg(ctx.api);
    const p = store.prices?.key === priceKey(coins, fiat) ? store.prices : null;
    const f = store.folio?.key === fiat ? store.folio : null;
    const busy = !!store.pendingPrices || !!store.pendingFolio;
    const at = tab === "folio" ? f?.at : p?.at;
    when.textContent = busy ? "atualizando…" : at ? `às ${clock(at)}` : "";
    again.disabled = busy;
    for (const t of Object.keys(tabs) as Tab[]) {
      tabs[t].classList.toggle("on", t === tab);
      tabs[t].setAttribute("aria-selected", String(t === tab));
    }
    const [parts, rows] = tab === "folio" ? folioPanel(fiat, hide) : pricesPanel(coins, fiat);
    clear(panel);
    panel.append(...parts);
    const fit = fitHeight(tab, rows);
    if (fit !== fitted) { fitted = fit; ctx.onResize(); }
  };
  const open = () => ctx.api.island.view() === "crypto" && ctx.api.island.mode() === "expanded";
  const readLinks =(at: number | null) => {
    linksFor = at;
    void Promise.all([cryptoBridge.status().catch(() => null), cryptoBridge.wallets().then((w) => w.length, () => null)])
      .then(([status, wallets]) => { links = { status, wallets }; if (open()) update(); });
  };
  const update = () => {
    const { coins, fiat, hide } = cryptoCfg(ctx.api);
    void store.loadPrices(coins, fiat);
    void store.loadPortfolio(fiat);
    const p = store.prices, f = store.folio;
    if (linksFor === null || (f && f.at !== linksFor)) readLinks(f?.at ?? 0);
    const sig = JSON.stringify([tab, coins, fiat, hide, p?.key, p?.at, p?.error, f?.key, f?.at, f?.error, store.pendingPrices, store.pendingFolio, links]);
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
    get height() { return fitted; },
    sync() {
      // Nothing is fetched or touched while the view is hidden or the island is folded.
      if (!open()) return;
      onSync();
      pin.sync();
      update();
    },
  };
}
