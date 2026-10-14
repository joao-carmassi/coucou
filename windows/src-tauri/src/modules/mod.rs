// Feature modules. The host (core/host.rs) starts and stops them from settings.

pub mod claude;
pub mod integrations;
pub mod media;
pub mod voice;

use crate::core::host::{Module, ModuleInfo};

pub const CATALOG: &[ModuleInfo] = &[
    ModuleInfo { id: "claude", label: "Claude Code", default_enabled: true, requires: &[], group: None },
    ModuleInfo { id: "media", label: "Mídia", default_enabled: true, requires: &[], group: None },
    ModuleInfo { id: "timer", label: "Timer", default_enabled: false, requires: &[], group: None },
    ModuleInfo { id: "upload", label: "Soltar arquivo", default_enabled: true, requires: &["claude"], group: Some("Precisam do Claude Code") },
    ModuleInfo { id: "voice", label: "Voz", default_enabled: false, requires: &["claude"], group: Some("Precisam do Claude Code") },
    ModuleInfo { id: "github", label: "GitHub", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "vercel", label: "Vercel", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "stripe", label: "Stripe", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "n8n", label: "n8n", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "resend", label: "Resend", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "calcom", label: "Cal.com", default_enabled: false, requires: &[], group: Some("Integrações") },
    ModuleInfo { id: "notion", label: "Notion", default_enabled: false, requires: &[], group: Some("Integrações") },
];

pub fn registry() -> Vec<Box<dyn Module>> {
    let mut v: Vec<Box<dyn Module>> = vec![Box::new(claude::Claude), Box::new(media::Media), Box::new(voice::Voice)];
    v.extend(integrations::providers());
    v
}

#[cfg(test)]
mod tests {
    use crate::core::host::Module;

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
