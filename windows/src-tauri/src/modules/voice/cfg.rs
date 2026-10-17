// The voice module's keys live in `Settings.extra`; this is the only place that knows their names.
// `modulesEnabled.voice` is the single on/off switch (`voiceEnabled` is a legacy mirror written by save_settings, read by the migration).

use serde_json::Value;

use crate::core::settings::Settings;

pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+V";

/// "" = no hotkey; a missing key = the default.
pub fn hotkey(s: &Settings) -> String {
    s.extra.get("voiceHotkey").and_then(Value::as_str).unwrap_or(DEFAULT_HOTKEY).to_string()
}

/// Languages whisper accepts from us; anything else becomes "auto".
pub const LANGS: [&str; 7] = ["auto", "pt", "en", "es", "fr", "de", "it"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Engine {
    Whistle,
    Whisper,
}

pub fn engine(s: &Settings) -> Engine {
    match s.extra.get("voiceEngine").and_then(Value::as_str) {
        Some("whisper") => Engine::Whisper,
        _ => Engine::Whistle,
    }
}

pub fn language(s: &Settings) -> &'static str {
    let v = s.extra.get("voiceLanguage").and_then(Value::as_str).unwrap_or("auto");
    LANGS.iter().find(|l| **l == v).copied().unwrap_or("auto")
}

/// "" = no hotkey (the assistant is off).
pub fn assist_hotkey(s: &Settings) -> String {
    s.extra.get("voiceAssistHotkey").and_then(Value::as_str).unwrap_or("").to_string()
}

/// Right Ctrl dictation into any app (the keyboard hook exists only while this is true).
pub fn flow_enabled(s: &Settings) -> bool {
    s.extra.get("voiceFlowEnabled").and_then(Value::as_bool).unwrap_or(false)
}

/// Pre-module settings.json: `voiceEnabled` was the switch. Only fills a missing `modulesEnabled.voice`.
pub fn migrate(s: &mut Settings) -> bool {
    if s.modules_enabled.contains_key("voice") {
        return false;
    }
    let on = s.extra.get("voiceEnabled").and_then(Value::as_bool).unwrap_or(false);
    s.modules_enabled.insert("voice".into(), on);
    true
}

/// Legacy mirror: rolling back to the old exe keeps the voice choice.
pub fn mirror_legacy(s: &mut Settings) {
    if let Some(on) = s.modules_enabled.get("voice").copied() {
        s.extra.insert("voiceEnabled".into(), serde_json::json!(on));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrate_from_voice_enabled() {
        let mut s: Settings = serde_json::from_str(r#"{"voiceEnabled":true}"#).unwrap();
        assert!(migrate(&mut s));
        assert!(s.module_on("voice", false));
        assert!(!migrate(&mut s), "idempotent");
        let mut none = Settings::default();
        migrate(&mut none);
        assert!(!none.module_on("voice", true), "no legacy key = off");
        let mut chosen: Settings = serde_json::from_str(r#"{"voiceEnabled":true,"modulesEnabled":{"voice":false}}"#).unwrap();
        assert!(!migrate(&mut chosen));
        assert!(!chosen.module_on("voice", true), "the user's switch wins");
    }

    #[test]
    fn save_mirrors_voice_enabled() {
        let mut s = Settings::default();
        mirror_legacy(&mut s);
        assert!(!s.extra.contains_key("voiceEnabled"), "no switch, no mirror");
        s.modules_enabled.insert("voice".into(), true);
        mirror_legacy(&mut s);
        assert_eq!(s.extra["voiceEnabled"], json!(true));
    }

    #[test]
    fn engine_and_language_fall_back() {
        let mut s = Settings::default();
        assert_eq!((engine(&s), language(&s)), (Engine::Whistle, "auto"));
        s.extra.insert("voiceEngine".into(), json!("whisper"));
        s.extra.insert("voiceLanguage".into(), json!("pt"));
        assert_eq!((engine(&s), language(&s)), (Engine::Whisper, "pt"));
        s.extra.insert("voiceEngine".into(), json!("x"));
        s.extra.insert("voiceLanguage".into(), json!("../../evil"));
        assert_eq!((engine(&s), language(&s)), (Engine::Whistle, "auto"));
    }

    #[test]
    fn flow_is_off_unless_chosen() {
        let mut s = Settings::default();
        assert!(!flow_enabled(&s));
        s.extra.insert("voiceFlowEnabled".into(), json!(true));
        assert!(flow_enabled(&s));
        s.extra.insert("voiceFlowEnabled".into(), json!("yes"));
        assert!(!flow_enabled(&s), "only a real boolean turns the hook on");
    }

    #[test]
    fn assistant_is_off_by_default() {
        let mut s = Settings::default();
        assert_eq!(assist_hotkey(&s), "");
        s.extra.insert("voiceAssistHotkey".into(), json!("Ctrl+Alt+Space"));
        assert_eq!(assist_hotkey(&s), "Ctrl+Alt+Space");
    }

    #[test]
    fn hotkey_default_and_empty() {
        let mut s = Settings::default();
        assert_eq!(hotkey(&s), "Ctrl+Alt+V");
        s.extra.insert("voiceHotkey".into(), json!(""));
        assert_eq!(hotkey(&s), "");
        s.extra.insert("voiceHotkey".into(), json!("Ctrl+Alt+M"));
        assert_eq!(hotkey(&s), "Ctrl+Alt+M");
    }
}
