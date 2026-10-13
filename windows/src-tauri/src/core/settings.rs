// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// Module-owned keys travel in `extra` untouched.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    /// Seconds the minimized island waits before hiding. 0 = never hide.
    #[serde(default = "default_compact_hide")]
    pub compact_hide_interval: f64,
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
            extra: Default::default(),
        }
    }
}

pub use crate::core::platform::{config_dir, local_dir};

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
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

    #[test]
    fn removed_keys_round_trip() {
        let sample = r#"{"soundEnabled":true,"soundVolume":0.12,"autoCloseInterval":10.0,"absenceInterval":180.0,"activeIntegrations":[],"screen":"primary","autostart":true,"hooksInstalled":true,"model":"claude-opus-5","githubMuted":[],"wslHooks":[],"wslPrompted":true,"chatBackend":"windows","claudeConfigDir":"","idleOpen":"terminal","mochiSession":{"backend":"windows","id":"x","cwd":null},"compactHideInterval":30.0,"askMode":"sessions"}"#;
        let want: serde_json::Value = serde_json::from_str(sample).unwrap();
        let parsed: Settings = serde_json::from_str(sample).unwrap();
        let back = serde_json::to_value(&parsed).unwrap();
        for (k, v) in want.as_object().unwrap() {
            assert_eq!(back.get(k), Some(v), "key {k}");
        }
    }
}
