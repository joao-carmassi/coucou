// Feature modules. The host (core/host.rs) starts and stops them from settings.

pub mod claude;
pub mod integrations;
pub mod media;
pub mod voice;

use crate::core::host::{Module, ModuleInfo};

pub const CATALOG: &[ModuleInfo] = &[
    ModuleInfo { id: "claude", label: "Claude Code", default_enabled: true, requires: &[], group: Some("Claude") },
    ModuleInfo { id: "media", label: "Mídia", default_enabled: true, requires: &[], group: None },
    ModuleInfo { id: "timer", label: "Timer", default_enabled: false, requires: &[], group: None },
    ModuleInfo { id: "upload", label: "Soltar arquivo", default_enabled: true, requires: &["claude"], group: Some("Claude") },
    ModuleInfo { id: "voice", label: "Voz", default_enabled: false, requires: &["claude"], group: Some("Claude") },
    ModuleInfo { id: "github", label: "GitHub", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "vercel", label: "Vercel", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "stripe", label: "Stripe", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "n8n", label: "n8n", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "resend", label: "Resend", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "calcom", label: "Cal.com", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "notion", label: "Notion", default_enabled: false, requires: &[], group: Some("Integrações") },
];

/// The invoke handler: core commands from the caller, then every module command (named `<id>_*`).
/// One `generate_handler!` so the list of module commands lives here, not in lib.rs.
macro_rules! handler {
    ($($core:path),* $(,)?) => {
        tauri::generate_handler![
            $($core,)*
            crate::modules::claude::commands::claude_open_app,
            crate::modules::claude::commands::claude_open_in_vscode,
            crate::modules::claude::commands::claude_open_terminal,
            crate::modules::claude::commands::claude_start_terminal,
            crate::modules::claude::commands::claude_resume_in_terminal,
            crate::modules::claude::commands::claude_profiles,
            crate::modules::claude::commands::claude_sessions_all,
            crate::modules::claude::commands::claude_sessions_live,
            crate::modules::claude::commands::claude_session_launch,
            crate::modules::claude::commands::claude_session_erase,
            crate::modules::claude::commands::claude_hooks_status,
            crate::modules::claude::commands::claude_hooks_preview,
            crate::modules::claude::commands::claude_hooks_apply,
            crate::modules::claude::commands::claude_wsl_distros,
            crate::modules::claude::commands::claude_wsl_status,
            crate::modules::claude::commands::claude_wsl_hooks_preview,
            crate::modules::claude::commands::claude_wsl_hooks_apply,
            crate::modules::claude::commands::claude_approval_decision,
            crate::modules::claude::commands::claude_approval_ack,
            crate::modules::claude::commands::claude_approval_decline,
            crate::modules::claude::commands::claude_approval_answer,
            crate::modules::claude::commands::claude_ingest_file,
            crate::modules::voice::voice::voice_start,
            crate::modules::voice::voice::voice_stop,
            crate::modules::voice::voice::voice_cancel,
            crate::modules::voice::voice::voice_model_status,
            crate::modules::voice::voice::voice_download_model,
            crate::modules::media::commands::media_attach_window,
            crate::modules::media::commands::media_list,
            crate::modules::media::commands::media_thumb,
            crate::modules::media::commands::media_open,
            crate::modules::media::commands::media_open_with,
            crate::modules::media::commands::media_reveal,
            crate::modules::media::commands::media_remove,
            crate::modules::integrations::commands::integrations_secret_present,
            crate::modules::integrations::commands::integrations_secret_set,
            crate::modules::integrations::commands::integrations_secret_clear,
            crate::modules::integrations::commands::github_test,
            crate::modules::integrations::commands::github_project,
            crate::modules::integrations::commands::github_day,
            crate::modules::integrations::commands::github_detail,
            crate::modules::integrations::commands::n8n_open,
            crate::modules::integrations::commands::integrations_refresh,
        ]
    };
}
pub(crate) use handler;

pub fn registry() -> Vec<Box<dyn Module>> {
    let mut v: Vec<Box<dyn Module>> = vec![Box::new(claude::Claude), Box::new(media::Media), Box::new(voice::Voice)];
    v.extend(integrations::providers());
    v
}

#[cfg(test)]
mod tests {
    use crate::core::host::Module;

    #[test]
    fn migrate_installed_baseline_and_legacy() {
        use crate::core::settings::{fill_defaults, Settings};
        let run = |json: &str| {
            let mut s: Settings = serde_json::from_str(json).unwrap();
            // Static calls: a `dyn Module` vtable would link tauri into the test exe (see below).
            let mut changed = super::voice::Voice.migrate(&mut s);
            for short in ["github", "vercel", "stripe", "n8n", "resend", "calcom", "notion"] {
                changed |= super::integrations::Provider { short }.migrate(&mut s);
            }
            (fill_defaults(super::CATALOG, &mut s) | changed, s)
        };
        let (changed, s) = run(r#"{"autostart":true,"model":"x","activeIntegrations":[],"voiceEnabled":true}"#);
        assert!(changed);
        let on: Vec<_> = s.modules_enabled.iter().filter(|(_, v)| **v).map(|(k, _)| k.as_str()).collect();
        assert_eq!(on, ["claude", "media", "upload", "voice"]);
        assert_eq!(s.extra["model"], "x", "unknown keys survive");
        let (changed, _) = run(&serde_json::to_string(&s).unwrap());
        assert!(!changed, "a migrated file is stable");
    }

    // Calling registry() would link all of tauri into the test exe, which cannot start without a
    // manifest (see core/host.rs tests): check the id statically and the entry in the source.
    #[test]
    fn claude_is_registered() {
        assert_eq!(super::claude::Claude.id(), "claude");
        assert!(super::CATALOG.iter().any(|m| m.id == "claude"));
        let src = include_str!("mod.rs");
        assert!(src.contains("vec![Box::new(claude::Claude)"), "registry() lost the claude entry");
    }
}
