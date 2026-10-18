// Cripto (F45): prices, plus the value of Coinbase / OKX accounts through READ-ONLY keys and of pasted public wallets.
// No Module impl: no thread, no timer. Every command works only when the view or the pinned line asks.
// Secrets live in the Credential Manager (core::secrets, owner `crypto`) and are read per request; they never reach the
// webview, settings.json, logs or an error text. A key that can trade or transfer is refused BEFORE anything is stored.
// No order, transfer or withdraw endpoint exists in this module (see net.rs).

mod chain;
mod coinbase;
mod net;
mod okx;

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::core::host::ModuleHost;
use crate::core::secrets as store;
use crate::core::settings;

pub const PREFIXES: &[&str] = &["crypto_"];

const OWNER: &str = "crypto";
const SLOTS: usize = 8;
const FIATS: &[&str] = &["BRL", "USD", "EUR"];
const PRICE_TTL: Duration = Duration::from_secs(60);
const FOLIO_TTL: Duration = Duration::from_secs(120);
const MAX_COINS: usize = 8;
const MAX_PRICED: usize = 25;
const TOO_LONG: usize = 4096;

/// Every secret this module may store; anything else is refused.
const KNOWN_KEYS: &[&str] = &["coinbase-name", "coinbase-pem", "okx-key", "okx-secret", "okx-pass"];
const WALLET_KEYS: [&str; SLOTS] = ["wallet1", "wallet2", "wallet3", "wallet4", "wallet5", "wallet6", "wallet7", "wallet8"];

fn get(key: &str) -> Option<String> {
    (KNOWN_KEYS.contains(&key) || WALLET_KEYS.contains(&key)).then(|| store::get(OWNER, key)).flatten()
}

fn put(key: &str, value: &str) -> Result<(), String> {
    if !(KNOWN_KEYS.contains(&key) || WALLET_KEYS.contains(&key)) {
        return Err("chave desconhecida".into());
    }
    store::set(OWNER, key, value).map_err(|_| "não foi possível gravar no Gerenciador de Credenciais".to_string())
}

fn clear(key: &str) {
    let _ = store::delete(OWNER, key);
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Price {
    pub coin: String,
    pub price: Option<f64>,
    /// 24 h change in percent (Coinbase product stats); None when the source has no such pair.
    pub change24h: Option<f64>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Row {
    pub ccy: String,
    pub amount: f64,
    pub value: Option<f64>,
    pub source: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Portfolio {
    pub total: f64,
    pub rows: Vec<Row>,
    /// Sources that failed this time ("coinbase", "okx", "wallet").
    pub errors: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct Wallet {
    pub slot: usize,
    pub kind: String,
    pub short: String,
}

#[derive(Serialize)]
pub struct Status {
    pub coinbase: bool,
    pub okx: bool,
}

type PriceCache = HashMap<String, (Instant, Result<f64, String>)>;
static PRICES: LazyLock<Mutex<PriceCache>> = LazyLock::new(Default::default);
static CHANGES: LazyLock<Mutex<HashMap<String, (Instant, Option<f64>)>>> = LazyLock::new(Default::default);
static FOLIO: LazyLock<Mutex<Option<(String, Instant, Portfolio)>>> = LazyLock::new(Default::default);

fn forget_portfolio() {
    if let Ok(mut f) = FOLIO.lock() {
        *f = None;
    }
}

fn fiat_ok(f: &str) -> Result<(), String> {
    FIATS.contains(&f).then_some(()).ok_or_else(|| "moeda não suportada".to_string())
}

fn coin_ok(c: &str) -> bool {
    (2..=10).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// Spot price of one coin in `fiat` (public Coinbase endpoint), cached 60 s, failures too.
async fn price(coin: &str, fiat: &str) -> Result<f64, String> {
    if coin == fiat {
        return Ok(1.0);
    }
    let key = format!("{coin}-{fiat}");
    if let Some((at, r)) = PRICES.lock().ok().and_then(|c| c.get(&key).cloned()) {
        if at.elapsed() < PRICE_TTL {
            return r;
        }
    }
    let r = fetch_price(&key).await;
    if let Ok(mut c) = PRICES.lock() {
        if c.len() > 200 {
            c.clear();
        }
        c.insert(key, (Instant::now(), r.clone()));
    }
    r
}

async fn fetch_price(pair: &str) -> Result<f64, String> {
    let v = net::get(net::url("api.coinbase.com", &format!("/v2/prices/{pair}/spot"), &[])?, &[]).await?;
    parse_spot(&v)
}

fn parse_spot(v: &serde_json::Value) -> Result<f64, String> {
    v["data"]["amount"].as_str().and_then(|s| s.parse::<f64>().ok()).filter(|p| p.is_finite() && *p >= 0.0).ok_or_else(|| "preço indisponível".to_string())
}

fn parse_change(v: &serde_json::Value) -> Option<f64> {
    v["price_percentage_change_24h"].as_str().and_then(|s| s.parse::<f64>().ok()).filter(|p| p.is_finite())
}

/// 24 h change of `coin` in percent, cached 60 s (misses too). The public product endpoint has no BRL pairs, so BRL
/// falls back to the USD pair (the coin's own move; the BRL/USD move is ignored). None when neither pair exists.
async fn change24h(coin: &str, fiat: &str) -> Option<f64> {
    if coin == fiat {
        return None;
    }
    let key = format!("{coin}-{fiat}");
    if let Some((at, r)) = CHANGES.lock().ok().and_then(|c| c.get(&key).cloned()) {
        if at.elapsed() < PRICE_TTL {
            return r;
        }
    }
    let mut r = None;
    for f in [fiat, "USD"] {
        let pair = format!("{coin}-{f}");
        let Ok(u) = net::url("api.coinbase.com", &format!("/api/v3/brokerage/market/products/{pair}"), &[]) else { break };
        if let Ok(v) = net::get(u, &[]).await {
            r = parse_change(&v);
            break;
        }
        if f == "USD" {
            break;
        }
    }
    if let Ok(mut c) = CHANGES.lock() {
        if c.len() > 200 {
            c.clear();
        }
        c.insert(key, (Instant::now(), r));
    }
    r
}

#[tauri::command]
pub async fn crypto_prices(host: State<'_, ModuleHost>, coins: Vec<String>, fiat: String) -> Result<Vec<Price>, String> {
    host.require("crypto")?;
    fiat_ok(&fiat)?;
    let mut out = Vec::new();
    // shortcut: sequential requests (a handful of coins, 60 s cache), no join of futures; upgrade if the list grows past 8.
    for c in coins.iter().take(MAX_COINS) {
        if !coin_ok(c) {
            return Err(format!("moeda inválida: {c}"));
        }
        match price(c, &fiat).await {
            Ok(p) => out.push(Price { coin: c.clone(), price: Some(p), change24h: change24h(c, &fiat).await, error: None }),
            Err(e) => out.push(Price { coin: c.clone(), price: None, change24h: None, error: Some(e) }),
        }
    }
    Ok(out)
}

fn region() -> String {
    settings::load().0.extra.get("cryptoOkxRegion").and_then(|v| v.as_str()).unwrap_or("www").to_string()
}

fn wallet_slot(slot: usize) -> Option<(String, String)> {
    let v = get(WALLET_KEYS.get(slot.checked_sub(1)?)?)?;
    let (k, a) = v.split_once(':')?;
    chain::valid_addr(k, a).then(|| (k.to_string(), a.to_string()))
}

/// Sums duplicate (source, currency) entries and drops zero balances.
fn merge(raw: Vec<(&'static str, String, f64)>) -> Vec<(&'static str, String, f64)> {
    let mut m: BTreeMap<(&'static str, String), f64> = BTreeMap::new();
    for (s, c, a) in raw {
        *m.entry((s, c)).or_default() += a;
    }
    m.into_iter().filter(|(_, a)| *a > 0.0).map(|((s, c), a)| (s, c, a)).collect()
}

async fn build(fiat: &str) -> Portfolio {
    let mut raw: Vec<(&'static str, String, f64)> = Vec::new();
    let mut errors: Vec<&'static str> = Vec::new();
    if let (Some(n), Some(p)) = (get("coinbase-name"), get("coinbase-pem")) {
        match coinbase::balances(&n, &p).await {
            Ok(b) => raw.extend(b.into_iter().map(|(c, a)| ("coinbase", c, a))),
            Err(_) => errors.push("coinbase"),
        }
    }
    if let (Some(k), Some(s), Some(p)) = (get("okx-key"), get("okx-secret"), get("okx-pass")) {
        match okx::balances(&region(), &okx::Creds { key: &k, secret: &s, pass: &p }).await {
            Ok(b) => raw.extend(b.into_iter().map(|(c, a)| ("okx", c, a))),
            Err(_) => errors.push("okx"),
        }
    }
    let mut wallet_failed = false;
    for slot in 1..=SLOTS {
        let Some((kind, addr)) = wallet_slot(slot) else { continue };
        match chain::balance(&kind, &addr).await {
            Ok(a) => raw.push(("wallet", kind.to_uppercase(), a)),
            Err(_) => wallet_failed = true,
        }
    }
    if wallet_failed {
        errors.push("wallet");
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut prices: HashMap<String, Option<f64>> = HashMap::new();
    for (source, ccy, amount) in merge(raw) {
        if !prices.contains_key(&ccy) {
            let p = if prices.len() < MAX_PRICED && coin_ok(&ccy) { price(&ccy, fiat).await.ok() } else { None };
            prices.insert(ccy.clone(), p);
        }
        let value = prices[&ccy].map(|p| p * amount);
        rows.push(Row { ccy, amount, value, source });
    }
    rows.sort_by(|a, b| b.value.unwrap_or(0.0).total_cmp(&a.value.unwrap_or(0.0)));
    let total = rows.iter().filter_map(|r| r.value).sum();
    Portfolio { total, rows, errors }
}

#[tauri::command]
pub async fn crypto_portfolio(host: State<'_, ModuleHost>, fiat: String) -> Result<Portfolio, String> {
    host.require("crypto")?;
    fiat_ok(&fiat)?;
    if let Some(p) = FOLIO.lock().ok().and_then(|f| f.as_ref().filter(|(k, at, _)| *k == fiat && at.elapsed() < FOLIO_TTL).map(|(_, _, p)| p.clone())) {
        return Ok(p);
    }
    let p = build(&fiat).await;
    if let Ok(mut f) = FOLIO.lock() {
        *f = Some((fiat, Instant::now(), p.clone()));
    }
    Ok(p)
}

/// Printable text only: control characters would break a header and a key never has them.
fn field<'a>(f: &'a HashMap<String, String>, k: &str, max: usize) -> Result<&'a str, String> {
    let v = f.get(k).map(|s| s.trim()).filter(|s| !s.is_empty()).ok_or_else(|| "preencha todos os campos".to_string())?;
    if v.len() > max || v.chars().any(|c| c.is_control() && c != '\n' && c != '\r') {
        return Err("campo inválido".into());
    }
    Ok(v)
}

#[tauri::command]
pub async fn crypto_connect(host: State<'_, ModuleHost>, exchange: String, fields: HashMap<String, String>) -> Result<(), String> {
    host.require("crypto")?;
    match exchange.as_str() {
        "coinbase" => {
            let name = field(&fields, "name", 300)?;
            let pem = coinbase::clean_pem(field(&fields, "pem", TOO_LONG)?);
            if !(name.starts_with("organizations/") && name.contains("/apiKeys/")) {
                return Err("o nome da chave deve ser organizations/…/apiKeys/…".into());
            }
            coinbase::check(&coinbase::permissions(name, &pem).await?)?;
            put("coinbase-name", name)?;
            if let Err(e) = put("coinbase-pem", &pem) {
                clear("coinbase-name");
                return Err(e);
            }
        }
        "okx" => {
            let (key, secret, pass) = (field(&fields, "key", 200)?, field(&fields, "secret", 200)?, field(&fields, "pass", 200)?);
            okx::check(&okx::perm(&region(), &okx::Creds { key, secret, pass }).await?)?;
            for (k, v) in [("okx-key", key), ("okx-secret", secret), ("okx-pass", pass)] {
                if let Err(e) = put(k, v) {
                    ["okx-key", "okx-secret", "okx-pass"].iter().for_each(|k| clear(k));
                    return Err(e);
                }
            }
        }
        _ => return Err("corretora desconhecida".into()),
    }
    forget_portfolio();
    Ok(())
}

/// Works while the module is off: the user must always be able to remove a key.
#[tauri::command]
pub fn crypto_disconnect(exchange: String) -> Result<(), String> {
    let keys: &[&str] = match exchange.as_str() {
        "coinbase" => &["coinbase-name", "coinbase-pem"],
        "okx" => &["okx-key", "okx-secret", "okx-pass"],
        _ => return Err("corretora desconhecida".into()),
    };
    keys.iter().for_each(|k| clear(k));
    forget_portfolio();
    Ok(())
}

#[tauri::command]
pub fn crypto_status(host: State<'_, ModuleHost>) -> Result<Status, String> {
    host.require("crypto")?;
    Ok(Status { coinbase: get("coinbase-name").is_some() && get("coinbase-pem").is_some(), okx: ["okx-key", "okx-secret", "okx-pass"].iter().all(|k| get(k).is_some()) })
}

#[tauri::command]
pub fn crypto_wallets(host: State<'_, ModuleHost>) -> Result<Vec<Wallet>, String> {
    host.require("crypto")?;
    Ok((1..=SLOTS).filter_map(|slot| wallet_slot(slot).map(|(kind, a)| Wallet { slot, kind, short: chain::short(&a) })).collect())
}

#[tauri::command]
pub fn crypto_wallet_add(host: State<'_, ModuleHost>, kind: String, addr: String) -> Result<(), String> {
    host.require("crypto")?;
    let (kind, addr) = (kind.to_lowercase(), addr.trim().to_string());
    if !chain::valid_addr(&kind, &addr) {
        return Err("endereço inválido para esta rede".into());
    }
    let mut free = None;
    for slot in 1..=SLOTS {
        match wallet_slot(slot) {
            Some((k, a)) if k == kind && a == addr => return Err("esse endereço já foi adicionado".into()),
            Some(_) => {}
            None => free = free.or(Some(slot)),
        }
    }
    let slot = free.ok_or_else(|| format!("limite de {SLOTS} carteiras"))?;
    put(WALLET_KEYS[slot - 1], &format!("{kind}:{addr}"))?;
    forget_portfolio();
    Ok(())
}

/// Works while the module is off.
#[tauri::command]
pub fn crypto_wallet_remove(slot: usize) -> Result<(), String> {
    let key = slot.checked_sub(1).and_then(|i| WALLET_KEYS.get(i)).ok_or("carteira inexistente")?;
    clear(key);
    forget_portfolio();
    Ok(())
}

pub fn modules() -> Vec<Box<dyn crate::core::host::Module>> {
    Vec::new()
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![
        crypto_prices, crypto_portfolio, crypto_connect, crypto_disconnect, crypto_status, crypto_wallets, crypto_wallet_add, crypto_wallet_remove
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_known_keys_are_stored() {
        assert!(put("github-token", "x").is_err());
        assert!(put("wallet9", "x").is_err());
        assert!(get("github-token").is_none());
        assert!(crypto_wallet_remove(0).is_err() && crypto_wallet_remove(9).is_err());
        assert!(crypto_disconnect("kraken".into()).is_err());
    }

    #[test]
    fn coins_and_fiats() {
        assert!(coin_ok("BTC") && coin_ok("USDT") && !coin_ok("btc") && !coin_ok("B") && !coin_ok("BTC/../x"));
        assert!(fiat_ok("BRL").is_ok() && fiat_ok("GBP").is_err());
    }

    #[test]
    fn spot_parser() {
        assert_eq!(parse_spot(&json!({"data": {"base": "BTC", "currency": "BRL", "amount": "612340.12"}})).unwrap(), 612340.12);
        assert!(parse_spot(&json!({"data": {"amount": "x"}})).is_err());
        assert!(parse_spot(&json!({"data": {"amount": "-1"}})).is_err());
        assert!(parse_spot(&json!({})).is_err());
    }

    #[test]
    fn change_parser() {
        assert_eq!(parse_change(&json!({"price": "1", "price_percentage_change_24h": "-0.41705239770413"})), Some(-0.41705239770413));
        assert_eq!(parse_change(&json!({"price_percentage_change_24h": "x"})), None);
        assert_eq!(parse_change(&json!({"error": "NOT_FOUND"})), None);
    }

    #[test]
    fn merge_sums_and_drops_zero() {
        let m = merge(vec![("okx", "BTC".into(), 0.5), ("okx", "BTC".into(), 0.25), ("okx", "ETH".into(), 0.0), ("wallet", "BTC".into(), 1.0)]);
        assert_eq!(m, vec![("okx", "BTC".to_string(), 0.75), ("wallet", "BTC".to_string(), 1.0)]);
    }

    #[test]
    fn fields_reject_blank_long_and_control() {
        let f = |k: &str, v: &str| HashMap::from([(k.to_string(), v.to_string())]);
        assert!(field(&f("a", " ok "), "a", 10).is_ok());
        assert!(field(&f("a", "  "), "a", 10).is_err());
        assert!(field(&f("a", "toolongvalue"), "a", 5).is_err());
        assert!(field(&f("a", "a\u{0}b"), "a", 10).is_err());
        assert!(field(&f("b", "x"), "a", 10).is_err());
    }
}
