// Claude plan limits through Claude Code's OAuth usage endpoint. UNDOCUMENTED and unofficial: opt-in (planusageClaudeNet),
// off by default. The token is Claude Code's: read per request, kept on the stack, never logged, never stored, never sent
// to the webview and NEVER refreshed (a refresh would rotate the CLI's credentials and log it out).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use super::codex::{now_ms, Window};

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
const MAX_BODY: usize = 64 * 1024;
pub const RENEW: &str = "Abra o Claude Code para renovar o login";
const NO_LOGIN: &str = "Login do Claude Code não encontrado";
const BAD_SHAPE: &str = "Resposta em formato desconhecido";

pub fn credentials_path() -> PathBuf {
    let dir = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => crate::core::platform::home_dir().join(".claude"),
    };
    dir.join(".credentials.json")
}

/// The access token, or the pt-BR reason there is none. An expired token is not sent (and not refreshed).
pub fn token_of(creds: &Value, now_ms: u64) -> Result<String, String> {
    let o = creds.get("claudeAiOauth").ok_or(NO_LOGIN)?;
    let t = o.get("accessToken").and_then(Value::as_str).filter(|t| !t.is_empty()).ok_or(NO_LOGIN)?;
    if o.get("expiresAt").and_then(Value::as_u64).is_some_and(|e| e <= now_ms) {
        return Err(RENEW.into());
    }
    Ok(t.to_string())
}

/// RFC 3339 -> unix ms (fraction ignored, any offset).
pub fn iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    let (y, m, d, hh, mm, ss) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // days from civil (Howard Hinnant)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    let tail = s[19..].trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let off = match tail.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let secs = (tail.get(1..3)?.parse::<i64>().ok()? * 60 + tail.get(4..6)?.parse::<i64>().ok()?) * 60;
            if sign == '+' { secs } else { -secs }
        }
        _ => 0,
    };
    u64::try_from((days * 86400 + hh * 3600 + mm * 60 + ss - off) * 1000).ok()
}

fn win(label: &str, used: Option<f64>, resets: Option<&Value>) -> Window {
    Window { label: label.into(), used_pct: used, resets_at: resets.and_then(Value::as_str).and_then(iso_ms) }
}

/// Both shapes seen so far: `{five_hour:{utilization,resets_at}, seven_day:{..}}` and `{limits:[{name,percent,resets_at}]}`.
pub fn parse_usage(v: &Value) -> Option<Vec<Window>> {
    let mut out = Vec::new();
    for (key, label) in [("five_hour", "5 h"), ("seven_day", "semana")] {
        if let Some(o) = v.get(key).filter(|o| o.is_object()) {
            out.push(win(label, o.get("utilization").and_then(Value::as_f64), o.get("resets_at")));
        }
    }
    if out.is_empty() {
        for l in v.get("limits")?.as_array()? {
            let name = l.get("name")?.as_str()?.to_lowercase();
            let label = limit_label(&name);
            out.push(win(&label, l.get("percent").and_then(Value::as_f64), l.get("resets_at")));
        }
    }
    out.sort_by_key(|w| w.label != "5 h"); // stable: the 5 h window first
    (!out.is_empty()).then_some(out)
}

/// "week" is matched first; model weeklies (weekly_opus...) keep their raw name so labels and notice keys do not collide.
fn limit_label(name: &str) -> String {
    let raw = || name.chars().take(24).collect::<String>();
    if name.contains("week") || name.contains("seven") {
        return if matches!(name, "week" | "weekly" | "seven_day" | "seven-day") { "semana".into() } else { raw() };
    }
    if ["five_hour", "five-hour", "5_hour", "5-hour", "5h", "session"].iter().any(|k| name.contains(k)) { "5 h".into() } else { raw() }
}

/// rustls reports an untrusted TLS-intercepting CA as `invalid peer certificate: UnknownIssuer`.
fn is_cert_error(chain: &str) -> bool {
    let c = chain.to_lowercase();
    c.contains("unknownissuer") || c.contains("certificate")
}

/// A fixed text per failure kind: reqwest's own message could carry the URL or headers.
fn net_error(e: &reqwest::Error) -> String {
    // The cause chain goes to the log only (hyper/rustls/io texts: no headers, no token).
    let mut src: &dyn std::error::Error = e;
    let mut chain = String::new();
    while let Some(n) = src.source() { chain.push_str(&format!(" <- {n}")); src = n; }
    crate::core::log::line(format!("planusage: request failed (timeout={}, connect={}){chain}", e.is_timeout(), e.is_connect()));
    if e.is_timeout() { "A Anthropic demorou demais para responder".into() }
    else if is_cert_error(&chain) { "Certificado não confiável (antivírus ou proxy HTTPS?)".into() }
    else if e.is_connect() { "Sem conexão com a Anthropic".into() }
    else { "Falha ao falar com a Anthropic".into() }
}

/// One request. Every error is a fixed pt-BR text: reqwest's own messages could carry the URL or headers.
pub async fn fetch() -> Result<Vec<Window>, String> {
    let creds: Value = std::fs::read(credentials_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or(NO_LOGIN)?;
    let token = token_of(&creds, now_ms())?;
    drop(creds);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Falha ao preparar a conexão".to_string())?;
    let mut res = client
        .get(URL)
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| net_error(&e))?;
    drop(token);
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(RENEW.into()),
        429 => return Err("Muitas consultas; tente mais tarde".into()),
        _ => return Err("A Anthropic não respondeu como esperado".into()),
    }
    let mut body = Vec::new();
    while let Some(c) = res.chunk().await.map_err(|_| "Falha ao ler a resposta".to_string())? {
        if body.len() + c.len() > MAX_BODY {
            return Err("Resposta grande demais".into());
        }
        body.extend_from_slice(&c);
    }
    let v: Value = serde_json::from_slice(&body).map_err(|_| BAD_SHAPE.to_string())?;
    parse_usage(&v).ok_or_else(|| BAD_SHAPE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cert_error_detected() {
        assert!(is_cert_error(" <- client error (Connect) <- invalid peer certificate: UnknownIssuer"));
        assert!(!is_cert_error(" <- tcp connect error <- os error 10061"));
    }

    #[test]
    #[ignore = "live network + the local Claude Code login"]
    fn live_fetch() {
        let r = tauri::async_runtime::block_on(fetch());
        eprintln!("live_fetch -> {:?}", r.as_ref().map(|w| w.len()));
        assert!(r.is_ok(), "{r:?}");
    }

    #[test]
    fn parses_both_shapes() {
        let a = parse_usage(&json!({"five_hour":{"utilization":23.0,"resets_at":"1970-01-02T00:00:00.000000+00:00"},"seven_day":{"utilization":8.5,"resets_at":null}})).unwrap();
        assert_eq!(a[0], Window { label: "5 h".into(), used_pct: Some(23.0), resets_at: Some(86_400_000) });
        assert_eq!(a[1].label, "semana");
        assert_eq!(a[1].resets_at, None);
        let b = parse_usage(&json!({"limits":[{"name":"five_hour","percent":10,"resets_at":"1970-01-01T00:00:01Z"},{"name":"seven_day","percent":4.0}]})).unwrap();
        assert_eq!((b[0].label.as_str(), b[0].used_pct, b[0].resets_at, b[1].label.as_str()), ("5 h", Some(10.0), Some(1000), "semana"));
    }

    #[test]
    fn limits_labels_are_explicit_and_five_hour_sorts_first() {
        let v = parse_usage(&json!({"limits":[
            {"name":"weekly_opus","percent":1},{"name":"seven_day","percent":2},{"name":"sonnet 5","percent":3},{"name":"session","percent":4}]})).unwrap();
        let l: Vec<_> = v.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(l, ["5 h", "weekly_opus", "semana", "sonnet 5"]);
        let o = parse_usage(&json!({"seven_day":{"utilization":1.0},"five_hour":{"utilization":2.0}})).unwrap();
        assert_eq!(o[0].label, "5 h");
    }

    #[test]
    fn garbage_is_none() {
        for v in [json!({}), json!([]), json!("x"), json!({"limits":"no"}), json!({"limits":[]}), json!({"five_hour":5})] {
            assert_eq!(parse_usage(&v), None, "{v}");
        }
    }

    #[test]
    fn iso_handles_offsets_and_junk() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(iso_ms("2000-03-01T00:00:00.5Z"), Some(951_868_800_000));
        assert_eq!(iso_ms("nope"), None);
        assert_eq!(iso_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn token_rules() {
        let ok = json!({"claudeAiOauth":{"accessToken":"t","expiresAt":2000}});
        assert_eq!(token_of(&ok, 1000).unwrap(), "t");
        assert_eq!(token_of(&ok, 2000).unwrap_err(), RENEW);
        assert!(token_of(&json!({}), 0).is_err());
        assert!(token_of(&json!({"claudeAiOauth":{"accessToken":""}}), 0).is_err());
    }
}
