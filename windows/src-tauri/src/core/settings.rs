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
    pub fn module_on(&self, id: &str, default: bool) -> bool {
        self.modules_enabled.get(id).copied().unwrap_or(default)
    }
}

pub use crate::core::platform::{config_dir, local_dir};

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

/// The bool is false when the file exists but could not be read or parsed: the caller must not save over it.
pub fn load() -> (Settings, bool) {
    match std::fs::read(settings_path()) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(s) => (s, true),
            Err(_) => {
                // Keep the unreadable file for the user; the original is not touched here.
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                if let Err(e) = std::fs::copy(settings_path(), config_dir().join(format!("settings.json.corrupt-{ts}"))) {
                    crate::core::log::line(format!("[settings] corrupt backup failed: {e}"));
                }
                (Settings::default(), false)
            }
        },
        Err(e) => (Settings::default(), e.kind() == std::io::ErrorKind::NotFound),
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
    fn load_invalid_json_flags_and_keeps_file() {
        let dir = std::env::temp_dir().join(format!("coucou-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Coucou")).unwrap();
        std::env::set_var("APPDATA", &dir);
        let file = dir.join("Coucou").join("settings.json");
        std::fs::write(&file, "{ not json").unwrap();
        let (_, ok) = load();
        assert!(!ok);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
        std::fs::remove_file(&file).unwrap();
        assert!(load().1, "missing file is a normal first run");
        let _ = std::fs::remove_dir_all(&dir);
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
