// API keys live in the Windows Credential Manager — never on disk and never in
// the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

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

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("chave desconhecida: {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("chave desconhecida: {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

/// The keys a provider cannot poll without (ids as in `activeIntegrations`).
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

/// True when at least one of these providers has its keys in the Credential Manager.
pub fn any_configured(active: &[String]) -> bool {
    active.iter().any(|id| configured(id))
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
        assert!(!any_configured(&[]));
    }

    #[test]
    fn unknown_key_is_refused() {
        assert!(set("nope", "x").is_err());
        assert!(clear("nope").is_err());
        assert!(get("nope").is_none());
    }
}
