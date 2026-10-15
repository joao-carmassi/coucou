// Credential Manager storage for secrets. Entry name is `<owner>-<key>` under one service name;
// callers own their allowlist.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

fn entry(owner_id: &str, key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{owner_id}-{key}")).map_err(|e| e.to_string())
}

pub fn get(owner_id: &str, key: &str) -> Option<String> {
    entry(owner_id, key).ok()?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(owner_id: &str, key: &str, value: &str) -> Result<(), String> {
    entry(owner_id, key)?.set_password(value).map_err(|e| e.to_string())
}

/// Deleting what is not there is not an error.
pub fn delete(owner_id: &str, key: &str) -> Result<(), String> {
    match entry(owner_id, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
