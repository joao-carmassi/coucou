// Public wallet balances, no key. Native coin only (no tokens). Addresses go to mempool.space, publicnode and the Solana RPC.

use serde_json::{json, Value};

use super::net;

const BECH32: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Charset and length only, no checksum: a typo gives a valid-looking empty address, never a loss.
// shortcut: no bech32/base58 checksum, upgrade if typos need catching before the first query.
pub fn valid_addr(kind: &str, a: &str) -> bool {
    let base58 = |s: &str| s.chars().all(|c| BASE58.contains(c));
    match kind {
        "btc" => {
            if let Some(rest) = a.strip_prefix("bc1") {
                (11..=71).contains(&rest.len()) && rest.chars().all(|c| BECH32.contains(c))
            } else {
                (26..=35).contains(&a.len()) && a.starts_with(['1', '3']) && base58(a)
            }
        }
        "eth" => a.strip_prefix("0x").is_some_and(|h| h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit())),
        "sol" => (32..=44).contains(&a.len()) && base58(a),
        _ => false,
    }
}

/// `bc1q…9xk4`: enough to recognise, not enough to copy.
pub fn short(a: &str) -> String {
    let n = a.chars().count();
    if n <= 12 {
        return a.to_string();
    }
    format!("{}…{}", a.chars().take(4).collect::<String>(), a.chars().skip(n - 4).collect::<String>())
}

pub fn parse_btc(v: &Value) -> Result<f64, String> {
    let sum = |k: &str| {
        let s = &v[k];
        Some(s["funded_txo_sum"].as_f64()? - s["spent_txo_sum"].as_f64()?)
    };
    Ok((sum("chain_stats").ok_or("resposta inesperada do mempool.space")? + sum("mempool_stats").unwrap_or(0.0)) / 1e8)
}

pub fn parse_eth(v: &Value) -> Result<f64, String> {
    let hex = v["result"].as_str().and_then(|s| s.strip_prefix("0x")).ok_or("resposta inesperada do nó Ethereum")?;
    u128::from_str_radix(hex, 16).map(|w| w as f64 / 1e18).map_err(|_| "resposta inesperada do nó Ethereum".into())
}

pub fn parse_sol(v: &Value) -> Result<f64, String> {
    v["result"]["value"].as_u64().map(|l| l as f64 / 1e9).ok_or_else(|| "resposta inesperada do nó Solana".into())
}

pub async fn balance(kind: &str, addr: &str) -> Result<f64, String> {
    if !valid_addr(kind, addr) {
        return Err("endereço inválido".into());
    }
    match kind {
        "btc" => parse_btc(&net::get(net::url("mempool.space", &format!("/api/address/{addr}"), &[])?, &[]).await?),
        "eth" => parse_eth(&net::rpc("ethereum-rpc.publicnode.com", &json!({"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance", "params": [addr, "latest"]})).await?),
        _ => parse_sol(&net::rpc("api.mainnet-beta.solana.com", &json!({"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [addr]})).await?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_table() {
        let ok = [
            ("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"),
            ("btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"),
            ("btc", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"),
            ("eth", "0x52908400098527886E0F7030069857D2E4169EE7"),
            ("sol", "11111111111111111111111111111111"),
            ("sol", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        ];
        for (k, a) in ok {
            assert!(valid_addr(k, a), "{k} {a}");
        }
        let bad = [
            ("btc", ""),
            ("btc", "bc1"),
            ("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdb"), // 'b' is not in the bech32 charset
            ("btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2/../x"),
            ("btc", "0BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"),
            ("eth", "0x1234"),
            ("eth", "52908400098527886E0F7030069857D2E4169EE7"),
            ("eth", "0xZZ908400098527886E0F7030069857D2E4169EE7"),
            ("sol", "short"),
            ("sol", "0OIl1111111111111111111111111111111111"),
            ("ltc", "LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL"),
        ];
        for (k, a) in bad {
            assert!(!valid_addr(k, a), "{k} {a}");
        }
    }

    #[test]
    fn shortening() {
        assert_eq!(short("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), "bc1q…5mdq");
        assert_eq!(short("abc"), "abc");
    }

    #[test]
    fn balance_parsers() {
        let btc = json!({"chain_stats": {"funded_txo_sum": 150_000_000u64, "spent_txo_sum": 50_000_000u64}, "mempool_stats": {"funded_txo_sum": 0, "spent_txo_sum": 10_000_000u64}});
        assert!((parse_btc(&btc).unwrap() - 0.9).abs() < 1e-12, "mempool spends count");
        assert!(parse_btc(&json!({})).is_err());
        assert_eq!(parse_eth(&json!({"result": "0xde0b6b3a7640000"})).unwrap(), 1.0);
        assert_eq!(parse_eth(&json!({"result": "0x0"})).unwrap(), 0.0);
        assert!(parse_eth(&json!({"result": "zz"})).is_err());
        assert_eq!(parse_sol(&json!({"result": {"value": 2_500_000_000u64}})).unwrap(), 2.5);
        assert!(parse_sol(&json!({"error": {}})).is_err());
    }
}
