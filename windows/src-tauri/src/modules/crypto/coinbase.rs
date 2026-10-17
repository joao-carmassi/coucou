// Coinbase Advanced Trade, read only. CDP keys sign a fresh ES256 JWT per request (exp = nbf + 120 s).
// Credentials come from the caller (read from secrets per request, or the candidate key being verified); never logged or returned.

use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::SecretKey;
use serde_json::{json, Value};

use super::net;

const HOST: &str = "api.coinbase.com";

#[derive(Debug, PartialEq)]
pub struct Perm {
    pub can_view: bool,
    pub can_trade: bool,
    pub can_transfer: bool,
}

/// `\n` pasted as two characters (JSON key files) becomes a real line break.
pub fn clean_pem(s: &str) -> String {
    s.trim().replace("\\n", "\n")
}

pub fn jwt(name: &str, pem: &str, method: &str, path: &str, now: u64, nonce: [u8; 16]) -> Result<String, String> {
    let key = SecretKey::from_sec1_pem(&clean_pem(pem)).map_err(|_| "chave PEM inválida".to_string())?;
    let header = json!({ "alg": "ES256", "kid": name, "nonce": net::hex(&nonce), "typ": "JWT" });
    let claims = json!({ "sub": name, "iss": "cdp", "nbf": now, "exp": now + 120, "uri": format!("{method} {HOST}{path}") });
    let input = format!("{}.{}", net::base64(header.to_string().as_bytes(), true), net::base64(claims.to_string().as_bytes(), true));
    let sig: Signature = SigningKey::from(key).sign(input.as_bytes());
    Ok(format!("{input}.{}", net::base64(&sig.to_bytes(), true)))
}

/// Unique per call is all the server asks of it; not a secret.
// shortcut: std RandomState + clock instead of an OS rng crate, upgrade if a nonce ever needs to be unpredictable.
fn nonce() -> [u8; 16] {
    use std::hash::{BuildHasher, Hasher};
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let mut out = [0u8; 16];
    for half in out.chunks_mut(8) {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(t);
        half.copy_from_slice(&h.finish().to_le_bytes());
    }
    out
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

async fn get(name: &str, pem: &str, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let token = jwt(name, pem, "GET", path, now(), nonce())?;
    net::get(net::url(HOST, path, query)?, &[("Authorization", &format!("Bearer {token}"))]).await
}

pub fn parse_perm(v: &Value) -> Result<Perm, String> {
    let b = |k: &str| v.get(k).and_then(Value::as_bool).ok_or_else(|| "resposta inesperada da Coinbase".to_string());
    Ok(Perm { can_view: b("can_view")?, can_trade: b("can_trade")?, can_transfer: b("can_transfer")? })
}

/// Only a key that can view and can neither trade nor transfer is accepted.
pub fn check(p: &Perm) -> Result<(), String> {
    if p.can_trade || p.can_transfer {
        return Err("Chave recusada: ela pode negociar ou transferir fundos. Crie uma chave somente de leitura (View).".into());
    }
    if !p.can_view {
        return Err("Chave recusada: ela não tem permissão de leitura (View).".into());
    }
    Ok(())
}

pub async fn permissions(name: &str, pem: &str) -> Result<Perm, String> {
    parse_perm(&get(name, pem, "/api/v3/brokerage/key_permissions", &[]).await?)
}

/// One page of `accounts`: (currency, available + hold) and the next cursor.
pub fn parse_accounts(v: &Value) -> Result<(Vec<(String, f64)>, Option<String>), String> {
    let list = v.get("accounts").and_then(Value::as_array).ok_or("resposta inesperada da Coinbase")?;
    let amount = |a: &Value, k: &str| a.get(k).and_then(|x| x.get("value")).and_then(Value::as_str).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let rows = list
        .iter()
        .filter_map(|a| Some((a.get("currency")?.as_str()?.to_uppercase(), amount(a, "available_balance") + amount(a, "hold"))))
        .collect();
    let next = (v.get("has_next").and_then(Value::as_bool) == Some(true)).then(|| v.get("cursor").and_then(Value::as_str).map(str::to_string)).flatten();
    Ok((rows, next))
}

pub async fn balances(name: &str, pem: &str) -> Result<Vec<(String, f64)>, String> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let mut q = vec![("limit", "250")];
        if let Some(c) = cursor.as_deref() {
            q.push(("cursor", c));
        }
        let (rows, next) = parse_accounts(&get(name, pem, "/api/v3/brokerage/accounts", &q).await?)?;
        all.extend(rows);
        match next {
            Some(n) => cursor = Some(n),
            None => break,
        }
    }
    Ok(all)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};
    use p256::pkcs8::LineEnding;

    /// A throw-away key (scalar 1..32), SEC1 PEM like the one Coinbase hands out.
    pub fn test_pem() -> String {
        let bytes: Vec<u8> = (1..=32).collect();
        SecretKey::from_slice(&bytes).unwrap().to_sec1_pem(LineEnding::LF).unwrap().to_string()
    }

    fn b64u_decode(s: &str) -> Vec<u8> {
        let a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let (mut acc, mut bits, mut out) = (0u32, 0, Vec::new());
        for c in s.chars() {
            acc = (acc << 6) | a.find(c).unwrap() as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        out
    }

    #[test]
    fn jwt_is_a_valid_es256_token() {
        let pem = test_pem();
        assert!(pem.contains("EC PRIVATE KEY"));
        let name = "organizations/o1/apiKeys/k1";
        let nonce = [7u8; 16];
        let t = jwt(name, &pem, "GET", "/api/v3/brokerage/accounts", 1_760_000_000, nonce).unwrap();
        let parts: Vec<&str> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value = serde_json::from_slice(&b64u_decode(parts[0])).unwrap();
        assert_eq!(header, json!({ "alg": "ES256", "kid": name, "nonce": "07".repeat(16), "typ": "JWT" }));
        let claims: Value = serde_json::from_slice(&b64u_decode(parts[1])).unwrap();
        assert_eq!(
            claims,
            json!({ "sub": name, "iss": "cdp", "nbf": 1_760_000_000u64, "exp": 1_760_000_120u64, "uri": "GET api.coinbase.com/api/v3/brokerage/accounts" })
        );
        let sig = b64u_decode(parts[2]);
        assert_eq!(sig.len(), 64, "fixed r||s");
        let vk = VerifyingKey::from(SigningKey::from(SecretKey::from_sec1_pem(&pem).unwrap()));
        vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &Signature::from_slice(&sig).unwrap()).unwrap();
        assert!(!t.contains('=') && !t.contains('+') && !t.contains('/'), "base64url without padding");
        // Deterministic signer: same input, same token.
        assert_eq!(t, jwt(name, &pem, "GET", "/api/v3/brokerage/accounts", 1_760_000_000, nonce).unwrap());
    }

    #[test]
    fn pem_with_escaped_newlines_works_and_garbage_never_echoes() {
        let escaped = test_pem().trim().replace('\n', "\\n");
        assert!(jwt("n", &escaped, "GET", "/x", 1, [0; 16]).is_ok());
        let e = jwt("n", "SEGREDO-NAO-VAZAR", "GET", "/x", 1, [0; 16]).unwrap_err();
        assert!(!e.contains("SEGREDO"));
    }

    #[test]
    fn nonces_differ() {
        assert_ne!(nonce(), nonce());
    }

    #[test]
    fn read_only_gate() {
        let ok = parse_perm(&json!({"can_view": true, "can_trade": false, "can_transfer": false})).unwrap();
        assert!(check(&ok).is_ok());
        for (v, t, x) in [(true, true, false), (true, false, true), (true, true, true), (false, false, false)] {
            assert!(check(&Perm { can_view: v, can_trade: t, can_transfer: x }).is_err());
        }
        assert!(parse_perm(&json!({"can_view": true})).is_err(), "a missing field is not a pass");
        assert!(parse_perm(&json!({"can_view": "true", "can_trade": false, "can_transfer": false})).is_err());
    }

    #[test]
    fn accounts_parse_and_paginate() {
        let v = json!({"accounts": [
            {"currency": "btc", "available_balance": {"value": "0.5", "currency": "BTC"}, "hold": {"value": "0.25"}},
            {"currency": "BRL", "available_balance": {"value": "10.5"}},
            {"available_balance": {"value": "1"}}],
            "has_next": true, "cursor": "abc"});
        let (rows, next) = parse_accounts(&v).unwrap();
        assert_eq!(rows, vec![("BTC".to_string(), 0.75), ("BRL".to_string(), 10.5)]);
        assert_eq!(next.as_deref(), Some("abc"));
        assert_eq!(parse_accounts(&json!({"accounts": [], "has_next": false, "cursor": "x"})).unwrap().1, None);
        assert!(parse_accounts(&json!({})).is_err());
    }
}
