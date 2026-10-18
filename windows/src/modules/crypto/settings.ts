// The Cripto section of the settings window: display, then one block each for Coinbase, OKX and the public wallets.
// Must not import index.ts. Keys and wallet addresses go to the Windows Credential Manager through Rust; this page never
// reads them back, it only learns whether each one is connected. Coucou refuses a key that can trade or transfer.
import "./settings.css";
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { cryptoBridge } from "./bridge";
import { fiatOf, FIATS, parseCoins, REGIONS } from "./logic";
import type { CryptoCfg, Status, Wallet } from "./logic";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NETS: Record<string, string> = { btc: "Bitcoin", eth: "Ethereum", sol: "Solana" };

/** A block with a head (name, state pill) and its rows. */
const block = (title: string, pill: HTMLElement | null, ...kids: Node[]) =>
  h("div", { class: "crypto-set" }, h("div", { class: "crypto-set-head" }, h("b", { text: title }), pill), ...kids);
/** The state pill: a dot and a word; `tone` "on", "off" or "err". */
function pill(): { el: HTMLElement; set(tone: "on" | "off" | "err" | "", text: string): void } {
  const text = h("span");
  const el = h("span", { class: "crypto-pill" }, h("i", { class: "dot" }), text);
  return { el, set(tone, t) { el.className = `crypto-pill ${tone}`; text.textContent = t; } };
}
/** A one-line reply under a block's buttons; "err" paints it red. */
function line(): { el: HTMLElement; say(t: string, err?: boolean): void } {
  const el = h("div", { class: "hint crypto-say", role: "status" });
  return { el, say(t, err = false) { el.textContent = t; el.classList.toggle("err", err); } };
}

function cryptoSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<CryptoCfg>();
  const field = (type: string, placeholder: string) => h("input", { class: "island-field", type, placeholder, autocomplete: "off", spellcheck: "false", maxlength: 300 }) as HTMLInputElement;
  const row = (label: string, ...kids: Node[]) => h("div", { class: "row" }, h("label", { text: label }), ...kids);

  // Display
  const coins = field("text", "BTC, ETH");
  coins.value = parseCoins(cfg.cryptoCoins).join(", ");
  coins.addEventListener("change", () => { const l = parseCoins(coins.value); coins.value = l.join(", "); void ms.save({ cryptoCoins: l }); });
  const fiat = h("select", {}, ...FIATS.map((f) => h("option", { value: f, text: f }))) as HTMLSelectElement;
  fiat.value = fiatOf(cfg.cryptoFiat);
  fiat.addEventListener("change", () => void ms.save({ cryptoFiat: fiat.value }));
  let hide = cfg.cryptoHideTotal !== false;
  const hideBtn = h("button", { class: hide ? "switch on" : "switch", "aria-pressed": hide, "aria-label": "Esconder os valores até passar o mouse" });
  hideBtn.addEventListener("click", () => {
    hide = !hide;
    hideBtn.className = hide ? "switch on" : "switch";
    hideBtn.setAttribute("aria-pressed", String(hide));
    void ms.save({ cryptoHideTotal: hide });
  });

  // Exchanges
  const cbPill = pill(), okPill = pill();
  const cbSay = line(), okSay = line();
  const cbName = field("text", "organizations/…/apiKeys/…");
  const cbPem = h("textarea", { class: "island-field", rows: 4, placeholder: "-----BEGIN EC PRIVATE KEY-----", autocomplete: "off", spellcheck: "false", maxlength: 4000 }) as HTMLTextAreaElement;
  const okKey = field("password", "API key");
  const okSecret = field("password", "Secret key");
  const okPass = field("password", "Passphrase");
  const region = h("select", {}, ...REGIONS.map(([v, t]) => h("option", { value: v, text: t }))) as HTMLSelectElement;
  region.value = REGIONS.some(([v]) => v === cfg.cryptoOkxRegion) ? String(cfg.cryptoOkxRegion) : "www";
  region.addEventListener("change", () => void ms.save({ cryptoOkxRegion: region.value }));
  const cbGo = h("button", { class: "btn primary", text: "Conectar" });
  const cbOff = h("button", { class: "btn secondary", text: "Remover chave" });
  const okGo = h("button", { class: "btn primary", text: "Conectar" });
  const okOff = h("button", { class: "btn secondary", text: "Remover chave" });

  const paint = (s: Status) => {
    for (const [on, p, go, off] of [[s.coinbase, cbPill, cbGo, cbOff], [s.okx, okPill, okGo, okOff]] as const) {
      p.set(on ? "on" : "off", on ? "Conectada · somente leitura" : "Não conectada");
      go.textContent = on ? "Trocar chave" : "Conectar";
      off.disabled = !on;
    }
  };
  const refreshStatus = () => cryptoBridge.status().then(paint, () => {
    cbPill.set("err", "Estado indisponível");
    okPill.set("err", "Estado indisponível");
  });
  const connect = async (ex: "coinbase" | "okx", fields: Record<string, string>, inputs: HTMLInputElement[], say: (t: string, err?: boolean) => void) => {
    say("Verificando a permissão da chave…");
    try {
      await cryptoBridge.connect(ex, fields);
      inputs.forEach((i) => { i.value = ""; });
      say("Conectada. A chave é somente de leitura.");
    } catch (e) { say(msg(e), true); }
    void refreshStatus();
  };
  const disconnect = async (ex: "coinbase" | "okx", say: (t: string, err?: boolean) => void) => {
    try { await cryptoBridge.disconnect(ex); say("Chave removida."); } catch (e) { say(msg(e), true); }
    void refreshStatus();
  };
  cbGo.addEventListener("click", () => { const pem = cbPem.value; cbPem.value = ""; void connect("coinbase", { name: cbName.value, pem }, [cbName], cbSay.say); });
  cbOff.addEventListener("click", () => void disconnect("coinbase", cbSay.say));
  okGo.addEventListener("click", () => void connect("okx", { key: okKey.value, secret: okSecret.value, pass: okPass.value }, [okKey, okSecret, okPass], okSay.say));
  okOff.addEventListener("click", () => void disconnect("okx", okSay.say));

  // Wallets
  const wPill = pill(), wSay = line();
  const list = h("div", { class: "crypto-wallets" });
  const kind = h("select", {}, ...Object.entries(NETS).map(([v, t]) => h("option", { value: v, text: t }))) as HTMLSelectElement;
  const addr = field("text", "Endereço público");
  const paintWallets = (ws: Wallet[]) => {
    wPill.set(ws.length ? "on" : "off", ws.length ? `${ws.length} ${ws.length === 1 ? "carteira" : "carteiras"}` : "Nenhuma");
    list.replaceChildren(...ws.map((w) => h("div", { class: "crypto-wallet" },
      h("span", { class: "crypto-net", text: NETS[w.kind] ?? w.kind.toUpperCase() }),
      h("code", { text: w.short }),
      h("span", { class: "grow" }),
      h("button", { class: "btn secondary", text: "Remover", onclick: () => void cryptoBridge.walletRemove(w.slot).then(() => { wSay.say("Carteira removida."); void loadWallets(); }, (e) => wSay.say(msg(e), true)) }))));
    list.hidden = !ws.length;
  };
  const loadWallets = () => cryptoBridge.wallets().then(paintWallets, () => { paintWallets([]); wPill.set("err", "Lista indisponível"); });
  const addWallet = async () => {
    try { await cryptoBridge.walletAdd(kind.value, addr.value); addr.value = ""; wSay.say("Carteira adicionada."); } catch (e) { wSay.say(msg(e), true); }
    void loadWallets();
  };
  addr.addEventListener("keydown", (e) => e.key === "Enter" && void addWallet());

  cbPill.set("", "Verificando…");
  okPill.set("", "Verificando…");
  wPill.set("", "Verificando…");
  void refreshStatus();
  void loadWallets();

  return {
    el: h("section", { id: "crypto" },
      h("h2", {}, h("span", { text: "Cripto" })),
      block("Exibição", null,
        row("Moedas", coins),
        row("Valores em", fiat),
        row("Esconder os valores", hideBtn),
        h("div", { class: "hint", text: "Até 8 moedas, separadas por vírgula. Com “Esconder os valores” ligado, o total e os saldos ficam borrados até você passar o mouse." })),
      block("Coinbase", cbPill.el,
        h("div", { class: "hint", text: "Crie uma chave de API da Coinbase (CDP) com permissão apenas de visualização (View). O Coucou recusa e não guarda chaves que possam negociar ou transferir." }),
        row("Nome da chave", cbName),
        row("Chave privada (PEM)", cbPem),
        h("div", { class: "actions" }, cbGo, cbOff),
        cbSay.el),
      block("OKX", okPill.el,
        h("div", { class: "hint", text: "Crie uma chave de API da OKX com permissão apenas de leitura (Read only). O Coucou recusa e não guarda chaves com permissão de negociar ou sacar." }),
        row("Região", region),
        row("API key", okKey),
        row("Secret key", okSecret),
        row("Passphrase", okPass),
        h("div", { class: "actions" }, okGo, okOff),
        okSay.el),
      block("Carteiras públicas", wPill.el,
        h("div", { class: "hint", text: "Só o endereço público: o Coucou lê o saldo, nunca pede a frase de recuperação nem a chave privada." }),
        list,
        row("Rede", kind),
        row("Endereço", addr, h("button", { class: "btn secondary", text: "Adicionar", onclick: () => void addWallet() })),
        wSay.el),
      h("div", { class: "hint", text: "As chaves ficam no Gerenciador de Credenciais do Windows, nunca no arquivo de configurações. Os nomes das moedas vão à Coinbase; cada chave só é usada na própria corretora; os endereços das carteiras vão ao mempool.space, à publicnode e à rede Solana. Nada é enviado enquanto a aba Cripto não estiver aberta ou fixada." })),
  };
}

export const settingsSections = { crypto: cryptoSettingsSection };
