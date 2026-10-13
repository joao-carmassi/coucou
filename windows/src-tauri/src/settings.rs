// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// GitHub projects ("owner/name") whose news the pill keeps to itself: a
    /// project not listed here speaks up, so a new one does by default.
    #[serde(default)]
    pub github_muted: Vec<String>,
    /// WSL distros whose Claude Code has Coucou's hooks, as last written or seen.
    /// Owned by Rust: the windows never send it (see `save_settings`).
    #[serde(default)]
    pub wsl_hooks: Vec<String>,
    /// The first-launch offer to set up WSL has been made. Shown once, ever.
    #[serde(default)]
    pub wsl_prompted: bool,
    /// A second Claude account: the folder Claude Code on Windows keeps its
    /// sign-in and sessions in (`CLAUDE_CONFIG_DIR`). Empty = the default `~/.claude`.
    #[serde(default)]
    pub claude_config_dir: String,
    /// What the idle Claude card opens: "" = Visual Studio Code, "terminal" =
    /// Claude Code in a new terminal, in the home folder.
    #[serde(default)]
    pub idle_open: String,
    /// Seconds the minimized island waits before hiding. 0 = never hide.
    #[serde(default = "default_compact_hide")]
    pub compact_hide_interval: f64,
    /// Voice input (voice.rs). Off until the user switches it on.
    #[serde(default)]
    pub voice_enabled: bool,
    #[serde(default = "default_voice_hotkey")]
    pub voice_hotkey: String,
    /// Global hotkey that emits `go-to-alert`; empty = none.
    #[serde(default = "default_alert_hotkey")]
    pub alert_hotkey: String,
    /// Keys this build no longer knows (the removed chat's `model`, `chatBackend`…):
    /// kept so saving never drops them from an installed settings.json.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_voice_hotkey() -> String {
    "Ctrl+Alt+V".into()
}

fn default_alert_hotkey() -> String {
    String::new()
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
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            github_muted: Vec::new(),
            wsl_hooks: Vec::new(),
            wsl_prompted: false,
            claude_config_dir: String::new(),
            idle_open: String::new(),
            compact_hide_interval: default_compact_hide(),
            voice_enabled: false,
            voice_hotkey: default_voice_hotkey(),
            alert_hotkey: default_alert_hotkey(),
            extra: Default::default(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// The folder set in "Account folder", `~` expanded; `None` for the default.
pub fn claude_config_dir() -> Option<PathBuf> {
    let dir = load().claude_config_dir;
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    match dir.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            Some(crate::platform::home_dir().join(rest.trim_start_matches(['/', '\\'])))
        }
        _ => Some(PathBuf::from(dir)),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
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
