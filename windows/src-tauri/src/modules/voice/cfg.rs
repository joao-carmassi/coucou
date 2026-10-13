// The voice module's keys live in `Settings.extra`; this is the only place that knows their names.
// `modulesEnabled.voice` is the single on/off switch (`voiceEnabled` is only read by the migration).

use serde_json::Value;

use crate::core::settings::Settings;

pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+V";

/// "" = no hotkey; a missing key = the default.
pub fn hotkey(s: &Settings) -> String {
    s.extra.get("voiceHotkey").and_then(Value::as_str).unwrap_or(DEFAULT_HOTKEY).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
