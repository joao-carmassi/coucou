// The claude module's keys live in `Settings.extra`; this is the only place that knows their names.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::core::settings::{self, Settings};

pub fn hook_exe_path() -> PathBuf {
    settings::local_dir().join("bin").join(crate::core::platform::HOOK_EXE)
}

pub fn wsl_hooks(s: &Settings) -> Vec<String> {
    s.extra
        .get("wslHooks")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

pub fn set_wsl_hooks(s: &mut Settings, list: Vec<String>) {
    s.extra.insert("wslHooks".into(), json!(list));
}

pub fn wsl_prompted(s: &Settings) -> bool {
    s.extra.get("wslPrompted").and_then(Value::as_bool).unwrap_or(false)
}

pub fn set_wsl_prompted(s: &mut Settings, v: bool) {
    s.extra.insert("wslPrompted".into(), json!(v));
}

/// The real state of ~/.claude/settings.json wins over whatever was stored; WSL is taken on trust
/// from the last write (asking every distro would start their VMs).
pub fn refresh_hooks_installed(s: &mut Settings) {
    let on = super::commands::any_hooks_installed() || !wsl_hooks(s).is_empty();
    s.extra.insert("hooksInstalled".into(), json!(on));
}

pub fn alert_hotkey(s: &Settings) -> String {
    s.extra.get("alertHotkey").and_then(Value::as_str).unwrap_or("").to_string()
}

/// The folder set in "Account folder", `~` expanded; `None` for the default. Read from disk, as before.
pub fn claude_config_dir() -> Option<PathBuf> {
    config_dir_of(&settings::load().0)
}

fn config_dir_of(s: &Settings) -> Option<PathBuf> {
    let dir = s.extra.get("claudeConfigDir").and_then(Value::as_str).unwrap_or("").trim();
    if dir.is_empty() {
        return None;
    }
    match dir.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            Some(crate::core::platform::home_dir().join(rest.trim_start_matches(['/', '\\'])))
        }
        _ => Some(PathBuf::from(dir)),
    }
}

/// `save_settings`: Rust's own bookkeeping must not be undone by a window holding an older copy.
pub fn keep_rust_owned(current: &Settings, incoming: &mut Settings) {
    for k in ["wslHooks", "wslPrompted", "hooksInstalled"] {
        match current.extra.get(k) {
            Some(v) => incoming.extra.insert(k.into(), v.clone()),
            None => incoming.extra.remove(k),
        };
    }
}

/// `save_settings`: Rust's bookkeeping survives a stale window, and the alert combo is normalised.
pub fn on_save(current: &Settings, incoming: &mut Settings) {
    keep_rust_owned(current, incoming);
    if let Some(v) = incoming.extra.get_mut("alertHotkey") {
        if let Some(s) = v.as_str() {
            *v = json!(crate::core::hotkeys::clean(s, ""));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_save_cleans_alert_hotkey_and_keeps_owned() {
        let mut cur = Settings::default();
        set_wsl_prompted(&mut cur, true);
        let mut inc = Settings::default();
        inc.extra.insert("alertHotkey".into(), json!("ctrl + alt+a"));
        on_save(&cur, &mut inc);
        assert_eq!(alert_hotkey(&inc), "Ctrl+Alt+A");
        assert!(wsl_prompted(&inc));
        inc.extra.insert("alertHotkey".into(), json!("nonsense"));
        on_save(&cur, &mut inc);
        assert_eq!(alert_hotkey(&inc), "");
    }

    #[test]
    fn rust_owned_keys_survive_a_stale_save() {
        let mut cur = Settings::default();
        set_wsl_hooks(&mut cur, vec!["Ubuntu".into()]);
        set_wsl_prompted(&mut cur, true);
        let mut stale = Settings::default();
        stale.extra.insert("wslHooks".into(), json!([]));
        stale.extra.insert("hooksInstalled".into(), json!(true));
        keep_rust_owned(&cur, &mut stale);
        assert_eq!(wsl_hooks(&stale), vec!["Ubuntu".to_string()]);
        assert!(wsl_prompted(&stale));
        assert!(!stale.extra.contains_key("hooksInstalled"));
    }

    #[test]
    fn config_dir_tilde() {
        let mut s = Settings::default();
        assert_eq!(config_dir_of(&s), None);
        s.extra.insert("claudeConfigDir".into(), json!("~/.claude-b"));
        assert!(config_dir_of(&s).unwrap().ends_with(".claude-b"));
    }
}
