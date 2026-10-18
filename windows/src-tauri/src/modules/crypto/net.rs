// The one door to the network for the crypto module: https only, fixed host allowlist, no redirects, 10 s, 256 KiB cap.
// Only GET, plus POST of a JSON-RPC body whose method is one of two balance reads. No order/transfer/withdraw endpoint exists.
// reqwest errors can echo URLs and headers, so they never leave here: every failure is a fixed pt-BR text.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;

pub const HOSTS: &[&str] = &[
    "api.coinbase.com",
    "www.okx.com",
    "us.okx.com",
    "eea.okx.com",
    "mempool.space",
    "ethereum-rpc.publicnode.com",
    "api.mainnet-beta.solana.com",
];
const RPC_METHODS: &[&str] = &["eth_getBalance", "getBalance"];
const MAX_BODY: usize = 256 * 1024;

pub fn url(host: &str, path: &str, query: &[(&str, &str)]) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse_with_params(&format!("https://{host}{path}"), query).map_err(|_| "endereço inválido".to_string())?;
    allowed(&u).then_some(u).ok_or_else(|| "servidor não permitido".to_string())
}

pub fn allowed(u: &reqwest::Url) -> bool {
    u.scheme() == "https" && u.port().is_none() && u.username().is_empty() && u.host_str().is_some_and(|h| HOSTS.contains(&h))
}

fn rpc_ok(body: &Value) -> bool {
    body["method"].as_str().is_some_and(|m| RPC_METHODS.contains(&m))
}

fn client() -> &'static reqwest::Client {
    static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    });
    &HTTP
}

pub async fn get(url: reqwest::Url, headers: &[(&str, &str)]) -> Result<Value, String> {
    if !allowed(&url) {
        return Err("servidor não permitido".into());
    }
    let mut req = client().get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    run(req).await
}

pub async fn rpc(host: &str, body: &Value) -> Result<Value, String> {
    if !rpc_ok(body) {
        return Err("chamada não permitida".into());
    }
    run(client().post(url(host, "/", &[])?).json(body)).await
}

async fn run(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let mut res = req.send().await.map_err(|_| "sem conexão com o serviço".to_string())?;
    let code = res.status().as_u16();
    match code {
        200..=299 => {}
        401 | 403 => return Err(format!("o serviço recusou as credenciais ({code})")),
        429 => return Err("limite de requisições do serviço atingido".into()),
        _ => return Err(format!("o serviço respondeu {code}")),
    }
    let mut body = Vec::new();
    while let Some(c) = res.chunk().await.map_err(|_| "falha ao ler a resposta do serviço".to_string())? {
        if body.len() + c.len() > MAX_BODY {
            return Err("resposta grande demais do serviço".into());
        }
        body.extend_from_slice(&c);
    }
    serde_json::from_slice(&body).map_err(|_| "resposta inválida do serviço".to_string())
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding; `url_safe` swaps +/ for -_ and drops the padding.
pub fn base64(data: &[u8], url_safe: bool) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..=c.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
        if !url_safe {
            out.extend(std::iter::repeat('=').take(3 - c.len()));
        }
    }
    if url_safe { out.replace('+', "-").replace('/', "_") } else { out }
}

pub fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist() {
        assert!(url("api.coinbase.com", "/v2/prices/BTC-BRL/spot", &[]).is_ok());
        assert!(url("mempool.space", "/api/address/x", &[]).is_ok());
        assert!(url("evil.example", "/", &[]).is_err());
        assert!(url("api.coinbase.com.evil.example", "/", &[]).is_err());
        assert!(url("api.coinbase.com:8443", "/", &[]).is_err(), "no custom port");
        let http = reqwest::Url::parse("http://api.coinbase.com/").unwrap();
        assert!(!allowed(&http));
        let userinfo = reqwest::Url::parse("https://user@api.coinbase.com/").unwrap();
        assert!(!allowed(&userinfo));
    }

    #[test]
    fn rpc_methods_are_fixed() {
        assert!(rpc_ok(&serde_json::json!({"method": "eth_getBalance"})));
        assert!(rpc_ok(&serde_json::json!({"method": "getBalance"})));
        assert!(!rpc_ok(&serde_json::json!({"method": "eth_sendRawTransaction"})));
        assert!(!rpc_ok(&serde_json::json!({"method": "sendTransaction"})));
        assert!(!rpc_ok(&serde_json::json!({})));
    }

    #[test]
    fn base64_vectors() {
        // RFC 4648 section 10.
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(i.as_bytes(), false), o);
        }
        assert_eq!(base64(&[0xfb, 0xff], false), "+/8=");
        assert_eq!(base64(&[0xfb, 0xff], true), "-_8");
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
