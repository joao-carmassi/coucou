// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// Module-owned keys travel in `extra` untouched.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    /// Seconds the minimized island waits before hiding. 0 = never hide.
    pub compact_hide_interval: f64,
    /// Module switches by id; a missing id means the module's default.
    pub modules_enabled: BTreeMap<String, bool>,
    /// Keys this build no longer knows (the removed chat's `model`, `chatBackend`…):
    /// kept so saving never drops them from an installed settings.json.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_compact_hide() -> f64 {
    60.0
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            screen: "primary".into(),
            autostart: false,
            compact_hide_interval: default_compact_hide(),
            modules_enabled: Default::default(),
            extra: Default::default(),
        }
    }
}

impl Settings {
    // used by the module ports (M5)
    #[allow(dead_code)]
    pub fn module_on(&self, id: &str, default: bool) -> bool {
        self.modules_enabled.get(id).copied().unwrap_or(default)
    }
}

pub use crate::core::platform::{config_dir, local_dir};

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            // Keep the unreadable file for the user; the original is not touched here.
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let _ = std::fs::copy(settings_path(), config_dir().join(format!("settings.json.corrupt-{ts}")));
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

/// Fills the switches a pre-module settings.json lacks; keys present are the user's. True when something was added.
pub fn migrate_modules(s: &mut Settings) -> bool {
    let voice = s.extra.get("voiceEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let integrations = s.extra.get("activeIntegrations").and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty());
    let mut added = false;
    for (id, on) in [
        ("claude", true),
        ("media", true),
        ("upload", true),
        ("timer", false),
        ("voice", voice),
        ("integrations", integrations),
    ] {
        if !s.modules_enabled.contains_key(id) {
            s.modules_enabled.insert(id.into(), on);
            added = true;
        }
    }
    added
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::core::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"soundEnabled":true,"soundVolume":0.12,"autoCloseInterval":10.0,"absenceInterval":180.0,"activeIntegrations":[],"screen":"primary","autostart":true,"hooksInstalled":true,"model":"claude-opus-5","githubMuted":[],"wslHooks":[],"wslPrompted":true,"chatBackend":"windows","claudeConfigDir":"","idleOpen":"terminal","mochiSession":{"backend":"windows","id":"x","cwd":null},"compactHideInterval":30.0,"askMode":"sessions"}"#;

    fn assert_keys_kept(s: &Settings) {
        let want: serde_json::Value = serde_json::from_str(SAMPLE).unwrap();
        let back = serde_json::to_value(s).unwrap();
        for (k, v) in want.as_object().unwrap() {
            assert_eq!(back.get(k), Some(v), "key {k}");
        }
    }

    #[test]
    fn removed_keys_round_trip() {
        let parsed: Settings = serde_json::from_str(SAMPLE).unwrap();
        assert_keys_kept(&parsed);
    }

    #[test]
    fn migrate_installed_baseline() {
        let mut s: Settings = serde_json::from_str(SAMPLE).unwrap();
        assert!(migrate_modules(&mut s));
        assert!(!migrate_modules(&mut s), "second call changes nothing");
        let want: BTreeMap<String, bool> =
            [("claude", true), ("media", true), ("upload", true), ("timer", false), ("voice", false), ("integrations", false)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
        assert_eq!(s.modules_enabled, want);
        assert_keys_kept(&s);
    }

    #[test]
    fn migrate_keeps_user_choice() {
        let mut s: Settings = serde_json::from_str(r#"{"modulesEnabled":{"timer":true,"claude":false}}"#).unwrap();
        migrate_modules(&mut s);
        assert!(s.module_on("timer", false));
        assert!(!s.module_on("claude", true));
    }

    #[test]
    fn migrate_from_legacy() {
        let mut s: Settings = serde_json::from_str(r#"{"voiceEnabled":true,"activeIntegrations":["github"]}"#).unwrap();
        migrate_modules(&mut s);
        assert!(s.module_on("voice", false));
        assert!(s.module_on("integrations", false));
    }
}
