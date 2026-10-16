// API keys live in the Windows Credential Manager — never on disk and never in
// the front end — the island can only ask whether a key is present.

use crate::core::secrets as store;

/// Every key Coucou may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

/// Stored entry is `<owner>-<key>`, which is exactly the allowlisted name: split at the first dash.
fn parts(key: &str) -> Option<(&str, &str)> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    key.split_once('-')
}

pub fn get(key: &str) -> Option<String> {
    let (o, k) = parts(key)?;
    store::get(o, k)
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let (o, k) = parts(key).ok_or_else(|| format!("chave desconhecida: {key}"))?;
    if value.is_empty() {
        let _ = store::delete(o, k);
        return Ok(());
    }
    store::set(o, k, value)
}

pub fn clear(key: &str) -> Result<(), String> {
    let (o, k) = parts(key).ok_or_else(|| format!("chave desconhecida: {key}"))?;
    store::delete(o, k)
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

/// The keys a provider cannot poll without (ids `integration_<short>`).
pub fn key_for(id: &str) -> &'static [&'static str] {
    match id {
        "integration_n8n" => &["n8n-url", "n8n-api-key"],
        "integration_vercel" => &["vercel-token"],
        "integration_stripe" => &["stripe-api-key"],
        "integration_resend" => &["resend-api-key"],
        "integration_github" => &["github-token"],
        "integration_calcom" => &["calcom-api-key"],
        "integration_notion" => &["notion-api-key"],
        _ => &[],
    }
}

/// True when every key the provider needs is stored.
pub fn configured(id: &str) -> bool {
    let keys = key_for(id);
    !keys.is_empty() && keys.iter().all(|k| present(k))
}

/// The provider module (short id) a key belongs to.
pub fn provider_of(key: &str) -> Option<&'static str> {
    match key {
        "n8n-url" | "n8n-api-key" => Some("n8n"),
        "vercel-token" => Some("vercel"),
        "github-token" => Some("github"),
        "stripe-api-key" => Some("stripe"),
        "resend-api-key" => Some("resend"),
        "notion-api-key" => Some("notion"),
        "calcom-api-key" => Some("calcom"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_needs_known_keys() {
        for id in [
            "integration_n8n",
            "integration_vercel",
            "integration_stripe",
            "integration_resend",
            "integration_github",
            "integration_calcom",
            "integration_notion",
        ] {
            let keys = key_for(id);
            assert!(!keys.is_empty(), "{id}");
            assert!(keys.iter().all(|k| KNOWN_KEYS.contains(k)), "{id}");
        }
        assert!(key_for("integration_x").is_empty());
        assert!(!configured("integration_x"));
        assert!(KNOWN_KEYS.iter().all(|k| provider_of(k).is_some()));
    }

    #[test]
    fn unknown_key_is_refused() {
        assert!(set("nope", "x").is_err());
        assert!(clear("nope").is_err());
        assert!(get("nope").is_none());
    }
}
