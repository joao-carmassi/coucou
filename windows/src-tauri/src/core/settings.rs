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
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    /// Seconds the minimized island waits before hiding. 0 = never hide.
    pub compact_hide_interval: f64,
    /// Minutes a held task view stays the reopen target. 0 = off.
    pub focus_hold_minutes: f64,
    /// Hide the island while a full-screen app or a call is in front.
    pub hide_when_busy: bool,
    /// Module switches by id; a missing id means the module's default.
    pub modules_enabled: BTreeMap<String, bool>,
    /// Version whose onboarding was finished; empty = first run (the Hub opens on the onboarding).
    #[serde(default = "legacy_onboarded")]
    pub onboarded_version: String,
    /// Body colour per Mochi (pill id, "<prefix>*" or "main" -> #rrggbb).
    pub mochi_colors: BTreeMap<String, String>,
    /// Minutes of rest before the main Mochi sleeps. 0 = never.
    pub mochi_sleep_minutes: f64,
    /// Global hotkey that opens the command palette; "" = none.
    pub palette_hotkey: String,
    /// Island offset from the centre of each display (key = `island::monitor_key`, value = logical px).
    pub island_placement: BTreeMap<String, f64>,
    /// Keys this build no longer knows (the removed chat's `model`, `chatBackend`…):
    /// kept so saving never drops them from an installed settings.json.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A file without the key predates the Hub: counted as onboarded (only a fresh install, `Default`, is "").
fn legacy_onboarded() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub const DEFAULT_PALETTE_HOTKEY: &str = "Ctrl+Alt+K";

fn default_compact_hide() -> f64 {
    60.0
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            screen: "primary".into(),
            autostart: false,
            compact_hide_interval: default_compact_hide(),
            focus_hold_minutes: 1.0,
            hide_when_busy: true,
            modules_enabled: Default::default(),
            onboarded_version: String::new(),
            mochi_colors: Default::default(),
            mochi_sleep_minutes: 10.0,
            palette_hotkey: DEFAULT_PALETTE_HOTKEY.into(),
            island_placement: Default::default(),
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

/// Fills the switches a pre-module settings.json lacks with the catalog default; keys present are the
/// user's. Legacy shapes are the modules' business (`Module::migrate`, run first). True when something was added.
pub fn fill_defaults(catalog: &[crate::core::host::ModuleInfo], s: &mut Settings) -> bool {
    let mut added = false;
    for m in catalog {
        if !s.modules_enabled.contains_key(m.id) {
            s.modules_enabled.insert(m.id.into(), m.default_enabled);
            added = true;
        }
    }
    added
}

/// Keys that may hold credentials: /token|secret|password|api_?key|cookie/i, same as the Hub's import filter.
fn secret_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    ["token", "secret", "password", "api_key", "apikey", "cookie"].iter().any(|s| k.contains(s))
}

/// Removes secret-looking keys at every depth.
pub fn strip_secrets(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(m) => {
            m.retain(|k, _| !secret_key(k));
            m.values_mut().for_each(strip_secrets);
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(strip_secrets),
        _ => {}
    }
}

/// Pretty JSON of the settings for backup: no secret-looking keys, plus the app `version`.
pub fn export_json(settings: &Settings, version: &str) -> String {
    let mut v = serde_json::to_value(for_disk(settings, crate::core::safe_mode::real_modules().as_ref())).unwrap_or_default();
    strip_secrets(&mut v);
    if let Some(o) = v.as_object_mut() {
        o.insert("version".into(), version.into());
    }
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

/// `current` with the patch's top-level keys replaced; the rest (known fields and `extra`) is untouched.
/// Err when a value has the wrong type for a known field: nothing is applied then.
pub fn merge_patch(current: &Settings, patch: serde_json::Map<String, serde_json::Value>) -> Result<Settings, String> {
    let mut v = serde_json::to_value(current).map_err(|e| e.to_string())?;
    v.as_object_mut().expect("Settings serializes to an object").extend(patch);
    serde_json::from_value(v).map_err(|e| e.to_string())
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    save_to(&for_disk(settings, crate::core::safe_mode::real_modules().as_ref()))
}

/// Safe mode runs with a reduced switch map in memory; the stored one is what reaches the disk.
fn for_disk(settings: &Settings, real: Option<&BTreeMap<String, bool>>) -> Settings {
    let mut s = settings.clone();
    if let Some(r) = real {
        s.modules_enabled = r.clone();
    }
    s
}

fn save_to(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::core::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    write_atomic(&settings_path(), &json)
}

static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Temp file in the same dir, then rename over the target (replaces on Windows): a crash never leaves a half file.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let _g = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
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
    fn atomic_write_keeps_last_and_no_tmp() {
        let dir = std::env::temp_dir().join(format!("coucou-atomic-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("settings.json");
        write_atomic(&f, b"one").unwrap();
        write_atomic(&f, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_mode_never_reaches_the_disk() {
        let mut s = Settings::default();
        s.modules_enabled.insert("x".into(), false);
        let real: BTreeMap<String, bool> = [("x".to_string(), true), ("y".to_string(), true)].into();
        assert_eq!(for_disk(&s, Some(&real)).modules_enabled, real);
        assert_eq!(for_disk(&s, None).modules_enabled, s.modules_enabled);
    }

    #[test]
    fn onboarding_only_for_fresh_installs() {
        assert_eq!(Settings::default().onboarded_version, "", "fresh install");
        let old: Settings = serde_json::from_str(r#"{"soundVolume":0.3}"#).unwrap();
        assert!(!old.onboarded_version.is_empty(), "upgrading user is not onboarded again");
        let set: Settings = serde_json::from_str(r#"{"onboardedVersion":"0.1.0"}"#).unwrap();
        assert_eq!(set.onboarded_version, "0.1.0");
    }

    #[test]
    fn export_drops_secret_keys_at_any_depth() {
        let mut s = Settings::default();
        s.extra.insert("githubToken".into(), "ghp_LEAK".into());
        s.extra.insert("nested".into(), serde_json::json!({"apiKey": "k_LEAK", "API_KEY2": "x", "keep": 1, "list": [{"Cookie": "c_LEAK", "ok": true}]}));
        s.extra.insert("clientSecret".into(), "s_LEAK".into());
        s.extra.insert("idleOpen".into(), "vscode".into());
        let out = export_json(&s, "9.9.9");
        assert!(!out.contains("LEAK"), "{out}");
        assert!(!out.contains("API_KEY2"));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["version"], "9.9.9");
        assert_eq!(v["idleOpen"], "vscode");
        assert_eq!(v["nested"]["keep"], 1);
        assert_eq!(v["nested"]["list"][0]["ok"], true);
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
    fn patch_replaces_only_given_keys_and_keeps_extra() {
        let cur: Settings = serde_json::from_str(SAMPLE).unwrap();
        let patch = serde_json::json!({"clockFormat": "12h", "soundVolume": 0.5, "idleOpen": "vscode"});
        let out = merge_patch(&cur, patch.as_object().unwrap().clone()).unwrap();
        assert_eq!(out.sound_volume, 0.5);
        assert_eq!(out.extra["clockFormat"], "12h");
        assert_eq!(out.extra["idleOpen"], "vscode");
        // everything else, known and unknown, is as it was
        assert_eq!(out.auto_close_interval, cur.auto_close_interval);
        assert_eq!(out.extra["claudeConfigDir"], cur.extra["claudeConfigDir"]);
        assert_eq!(out.extra["mochiSession"], cur.extra["mochiSession"]);
        let (mut a, mut b) = (serde_json::to_value(&cur).unwrap(), serde_json::to_value(&out).unwrap());
        for k in ["soundVolume", "clockFormat", "idleOpen"] { a.as_object_mut().unwrap().remove(k); b.as_object_mut().unwrap().remove(k); }
        assert_eq!(a, b);
        assert_eq!(merge_patch(&cur, Default::default()).unwrap().extra, cur.extra, "empty patch is a no-op");
    }

    #[test]
    fn patch_with_a_wrong_type_is_refused() {
        let cur = Settings::default();
        let patch = serde_json::json!({"soundVolume": "loud"});
        let err = merge_patch(&cur, patch.as_object().unwrap().clone()).unwrap_err();
        assert!(err.contains("invalid type"), "the caller gets the reason: {err}");
    }

    #[test]
    fn removed_keys_round_trip() {
        let parsed: Settings = serde_json::from_str(SAMPLE).unwrap();
        assert_keys_kept(&parsed);
    }

    #[test]
    fn fill_defaults_installed_baseline() {
        let cat = crate::modules::CATALOG;
        let mut s: Settings = serde_json::from_str(SAMPLE).unwrap();
        assert!(fill_defaults(cat, &mut s));
        assert!(!fill_defaults(cat, &mut s), "second call changes nothing");
        let want: BTreeMap<String, bool> = cat.iter().map(|m| (m.id.to_string(), m.default_enabled)).collect();
        assert_eq!(s.modules_enabled, want);
        assert_keys_kept(&s);
    }

    #[test]
    fn fill_defaults_keeps_user_choice() {
        let mut s: Settings = serde_json::from_str(r#"{"modulesEnabled":{"timer":true,"claude":false}}"#).unwrap();
        fill_defaults(crate::modules::CATALOG, &mut s);
        assert!(s.module_on("timer", false));
        assert!(!s.module_on("claude", true));
    }

    #[test]
    fn board_is_filled_on_for_an_older_settings_file() {
        // A settings.json from before the board existed: the choices stay, the board comes on, nothing else moves.
        let old = r#"{"soundVolume":0.3,"modulesEnabled":{"claude":false,"media":true,"github":true},"idleOpen":"vscode"}"#;
        let mut s: Settings = serde_json::from_str(old).unwrap();
        assert!(fill_defaults(crate::modules::CATALOG, &mut s));
        assert!(s.module_on("board", false), "board defaults on");
        assert!(!s.module_on("claude", true) && s.module_on("github", false), "the user's choices stay");
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["idleOpen"], "vscode");
        assert_eq!(back["modulesEnabled"]["board"], true);
        let again: Settings = serde_json::from_value(back).unwrap();
        assert_eq!(again.modules_enabled, s.modules_enabled);
    }
}
