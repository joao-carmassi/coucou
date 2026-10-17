// The Cripto section of the settings window. Must not import index.ts.
// Keys and wallet addresses go to the Windows Credential Manager through Rust; this page never reads them back,
// it only learns whether each one is connected. Coucou refuses a key that can trade or transfer.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { cryptoBridge } from "./bridge";
import { fiatOf, FIATS, parseCoins, REGIONS } from "./logic";
import type { CryptoCfg, Status, Wallet } from "./logic";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function cryptoSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<CryptoCfg>();
  const field = (type: string, placeholder: string) => h("input", { class: "island-field", type, placeholder, autocomplete: "off", spellcheck: "false", maxlength: 300 }) as HTMLInputElement;
  const row = (label: string, ...kids: Node[]) => h("div", { class: "row" }, h("label", { text: label }), ...kids);

  const coins = field("text", "BTC, ETH");
  coins.value = parseCoins(cfg.cryptoCoins).join(", ");
  coins.addEventListener("change", () => { const l = parseCoins(coins.value); coins.value = l.join(", "); void ms.save({ cryptoCoins: l }); });
  const fiat = h("select", {}, ...FIATS.map((f) => h("option", { value: f, text: f }))) as HTMLSelectElement;
  fiat.value = fiatOf(cfg.cryptoFiat);
  fiat.addEventListener("change", () => void ms.save({ cryptoFiat: fiat.value }));
  let hide = cfg.cryptoHideTotal !== false;
  const hideBtn = h("button", { class: hide ? "switch on" : "switch", "aria-pressed": hide, "aria-label": "Esconder o total até passar o mouse" });
  hideBtn.addEventListener("click", () => {
    hide = !hide;
    hideBtn.className = hide ? "switch on" : "switch";
    hideBtn.setAttribute("aria-pressed", String(hide));
    void ms.save({ cryptoHideTotal: hide });
  });

  const msgBox = h("div", { class: "sub" });
  const say = (t: string) => { msgBox.textContent = t; };

  // Exchanges
  const cbState = h("div", { class: "sub" });
  const cbName = field("text", "organizations/…/apiKeys/…");
  const cbPem = h("textarea", { class: "island-field", rows: 4, placeholder: "-----BEGIN EC PRIVATE KEY-----", autocomplete: "off", spellcheck: "false", maxlength: 4000 }) as HTMLTextAreaElement;
  const okState = h("div", { class: "sub" });
  const okKey = field("password", "API key");
  const okSecret = field("password", "Secret key");
  const okPass = field("password", "Passphrase");
  const region = h("select", {}, ...REGIONS.map(([v, t]) => h("option", { value: v, text: t }))) as HTMLSelectElement;
  region.value = REGIONS.some(([v]) => v === cfg.cryptoOkxRegion) ? String(cfg.cryptoOkxRegion) : "www";
  region.addEventListener("change", () => void ms.save({ cryptoOkxRegion: region.value }));

  const paint = (s: Status) => {
    cbState.textContent = s.coinbase ? "Coinbase: conectada (somente leitura)." : "Coinbase: não conectada.";
    okState.textContent = s.okx ? "OKX: conectada (somente leitura)." : "OKX: não conectada.";
  };
  const refreshStatus = () => cryptoBridge.status().then(paint, () => { cbState.textContent = okState.textContent = ""; });
  const connect = async (ex: "coinbase" | "okx", fields: Record<string, string>, inputs: HTMLInputElement[]) => {
    say("Verificando a permissão da chave…");
    try {
      await cryptoBridge.connect(ex, fields);
      inputs.forEach((i) => { i.value = ""; });
      say("Conectada. A chave é somente de leitura.");
    } catch (e) { say(msg(e)); }
    void refreshStatus();
  };
  const disconnect = async (ex: "coinbase" | "okx") => {
    try { await cryptoBridge.disconnect(ex); say("Chave removida."); } catch (e) { say(msg(e)); }
    void refreshStatus();
  };

  // Wallets
  const list = h("div", { class: "stack" });
  const kind = h("select", {}, ...[["btc", "Bitcoin"], ["eth", "Ethereum"], ["sol", "Solana"]].map(([v, t]) => h("option", { value: v, text: t }))) as HTMLSelectElement;
  const addr = field("text", "Endereço público");
  const paintWallets = (ws: Wallet[]) => {
    list.replaceChildren(...(ws.length ? ws : []).map((w) => h("div", { class: "row" },
      h("span", { text: `${w.kind.toUpperCase()} ${w.short}` }),
      h("button", { class: "btn secondary", text: "Remover", onclick: () => void cryptoBridge.walletRemove(w.slot).then(loadWallets, (e) => say(msg(e))) }))));
    if (!ws.length) list.replaceChildren(h("div", { class: "sub", text: "Nenhuma carteira adicionada." }));
  };
  const loadWallets = () => cryptoBridge.wallets().then(paintWallets, () => paintWallets([]));
  const addWallet = async () => {
    try { await cryptoBridge.walletAdd(kind.value, addr.value); addr.value = ""; say("Carteira adicionada."); } catch (e) { say(msg(e)); }
    void loadWallets();
  };

  void refreshStatus();
  void loadWallets();

  return {
    el: h("section", { id: "crypto" },
      h("h2", {}, h("span", { text: "Cripto" })),
      row("Moedas", coins),
      row("Valores em", fiat),
      row("Esconder o total", hideBtn),
      h("h3", { text: "Coinbase" }),
      h("div", { class: "sub", text: "Crie uma chave de API da Coinbase (CDP) com permissão apenas de visualização (View). O Coucou recusa e não guarda chaves que possam negociar ou transferir." }),
      cbState,
      row("Nome da chave", cbName),
      row("Chave privada (PEM)", cbPem),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", text: "Conectar", onclick: () => { const pem = cbPem.value; cbPem.value = ""; void connect("coinbase", { name: cbName.value, pem }, [cbName]); } }),
        h("button", { class: "btn secondary", text: "Remover chave", onclick: () => void disconnect("coinbase") })),
      h("h3", { text: "OKX" }),
      h("div", { class: "sub", text: "Crie uma chave de API da OKX com permissão apenas de leitura (Read only). O Coucou recusa e não guarda chaves com permissão de negociar ou sacar." }),
      okState,
      row("Região", region),
      row("API key", okKey),
      row("Secret key", okSecret),
      row("Passphrase", okPass),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", text: "Conectar", onclick: () => void connect("okx", { key: okKey.value, secret: okSecret.value, pass: okPass.value }, [okKey, okSecret, okPass]) }),
        h("button", { class: "btn secondary", text: "Remover chave", onclick: () => void disconnect("okx") })),
      h("h3", { text: "Carteiras públicas" }),
      list,
      row("Rede", kind),
      row("Endereço", addr, h("button", { class: "btn secondary", text: "Adicionar", onclick: () => void addWallet() })),
      msgBox,
      h("div", { class: "sub", text: "As chaves ficam no Gerenciador de Credenciais do Windows, nunca no arquivo de configurações. Os nomes das moedas vão à Coinbase; cada chave só é usada na própria corretora; os endereços das carteiras vão ao mempool.space, à publicnode e à rede Solana. Nada é enviado enquanto a aba Cripto não estiver aberta ou fixada." })),
  };
}

export const settingsSections = { crypto: cryptoSettingsSection };
