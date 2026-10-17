// OKX v5, read only. Each request is signed: base64(HMAC-SHA256(secret, timestamp + METHOD + path?query + body)).
// Credentials come from the caller (secrets per request, or the candidate key being verified); never logged or returned.

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use super::net;

pub struct Creds<'a> {
    pub key: &'a str,
    pub secret: &'a str,
    pub pass: &'a str,
}

/// `www` (global), `us` or `eea`; anything else is `www`.
pub fn host(region: &str) -> &'static str {
    match region {
        "us" => "us.okx.com",
        "eea" => "eea.okx.com",
        _ => "www.okx.com",
    }
}

pub fn hmac_b64(secret: &str, msg: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac takes any key length");
    m.update(msg.as_bytes());
    net::base64(&m.finalize().into_bytes(), false)
}

pub fn sign(secret: &str, ts: &str, method: &str, path_with_query: &str, body: &str) -> String {
    hmac_b64(secret, &format!("{ts}{method}{path_with_query}{body}"))
}

/// `2026-10-17T12:34:56.789Z` from epoch milliseconds.
pub fn iso_ts(ms: u64) -> String {
    let (days, rem) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

async fn get(region: &str, path: &str, c: &Creds<'_>) -> Result<Value, String> {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let ts = iso_ts(ms);
    let sig = sign(c.secret, &ts, "GET", path, "");
    let v = net::get(
        net::url(host(region), path, &[])?,
        &[("OK-ACCESS-KEY", c.key), ("OK-ACCESS-SIGN", &sig), ("OK-ACCESS-TIMESTAMP", &ts), ("OK-ACCESS-PASSPHRASE", c.pass)],
    )
    .await?;
    // OKX answers 200 with a non-zero code for a rejected key.
    if v.get("code").and_then(Value::as_str) != Some("0") {
        return Err("a OKX recusou as credenciais ou o pedido".into());
    }
    Ok(v)
}

pub fn parse_perm(v: &Value) -> Result<String, String> {
    v["data"][0]["perm"].as_str().map(str::to_string).ok_or_else(|| "resposta inesperada da OKX".to_string())
}

/// Only `read_only` passes. "read_only,trade" or "withdraw" is refused.
pub fn check(perm: &str) -> Result<(), String> {
    if perm.split(',').all(|p| p.trim() == "read_only") {
        Ok(())
    } else {
        Err("Chave recusada: ela pode negociar ou transferir fundos. Crie uma chave somente de leitura (Read).".into())
    }
}

pub async fn perm(region: &str, c: &Creds<'_>) -> Result<String, String> {
    parse_perm(&get(region, "/api/v5/account/config", c).await?)
}

fn num(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(0.0)
}

/// Trading account: `data[0].details[]` with `cashBal`.
pub fn parse_trading(v: &Value) -> Vec<(String, f64)> {
    v["data"][0]["details"].as_array().into_iter().flatten().filter_map(|d| Some((d.get("ccy")?.as_str()?.to_uppercase(), num(d, "cashBal")))).collect()
}

/// Funding account: `data[]` with `bal`.
pub fn parse_funding(v: &Value) -> Vec<(String, f64)> {
    v["data"].as_array().into_iter().flatten().filter_map(|d| Some((d.get("ccy")?.as_str()?.to_uppercase(), num(d, "bal")))).collect()
}

/// Trading plus funding, one entry per call (the caller sums per currency).
pub async fn balances(region: &str, c: &Creds<'_>) -> Result<Vec<(String, f64)>, String> {
    let mut all = parse_trading(&get(region, "/api/v5/account/balance", c).await?);
    all.extend(parse_funding(&get(region, "/api/v5/asset/balances", c).await?));
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hmac_rfc4231_case2() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
        let want = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
        let bytes: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&want[i * 2..i * 2 + 2], 16).unwrap()).collect();
        assert_eq!(hmac_b64("Jefe", "what do ya want for nothing?"), net::base64(&bytes, false));
    }

    #[test]
    fn sign_concatenates_in_okx_order() {
        let ts = "2020-12-08T09:08:57.715Z";
        let path = "/api/v5/account/balance?ccy=BTC";
        assert_eq!(sign("sec", ts, "GET", path, ""), hmac_b64("sec", &format!("{ts}GET{path}")));
        assert_ne!(sign("sec", ts, "GET", path, ""), sign("sec", ts, "POST", path, ""));
        assert_ne!(sign("sec", ts, "GET", path, ""), sign("sec2", ts, "GET", path, ""));
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(iso_ts(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ts(1_607_418_537_715), "2020-12-08T09:08:57.715Z");
        assert_eq!(iso_ts(1_709_210_096_005), "2024-02-29T12:34:56.005Z", "leap day");
    }

    #[test]
    fn read_only_gate() {
        assert!(check("read_only").is_ok());
        for p in ["trade", "withdraw", "read_only,trade", "read_only,withdraw", ""] {
            assert!(check(p).is_err(), "{p}");
        }
        assert_eq!(parse_perm(&json!({"code": "0", "data": [{"perm": "trade"}]})).unwrap(), "trade");
        assert!(parse_perm(&json!({"data": []})).is_err(), "no perm is not a pass");
    }

    #[test]
    fn regions_pick_allowlisted_hosts() {
        for r in ["www", "us", "eea", "evil.example", ""] {
            assert!(net::HOSTS.contains(&host(r)), "{r}");
        }
        assert_eq!(host("us"), "us.okx.com");
    }

    #[test]
    fn balance_parsers() {
        let trading = json!({"code": "0", "data": [{"details": [{"ccy": "btc", "cashBal": "0.1"}, {"ccy": "USDT", "cashBal": ""}, {"cashBal": "1"}]}]});
        assert_eq!(parse_trading(&trading), vec![("BTC".to_string(), 0.1), ("USDT".to_string(), 0.0)]);
        let funding = json!({"code": "0", "data": [{"ccy": "ETH", "bal": "2.5"}]});
        assert_eq!(parse_funding(&funding), vec![("ETH".to_string(), 2.5)]);
        assert!(parse_trading(&json!({})).is_empty());
    }
}
