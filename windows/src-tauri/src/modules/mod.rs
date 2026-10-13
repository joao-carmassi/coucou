// Feature modules. The host (core/host.rs) starts and stops them from settings.

pub mod claude;
pub mod voice;

use crate::core::host::{Module, ModuleInfo};

pub const CATALOG: &[ModuleInfo] = &[
    ModuleInfo { id: "claude", label: "Claude Code", default_enabled: true, requires: &[] },
    ModuleInfo { id: "media", label: "Mídia", default_enabled: true, requires: &[] },
    ModuleInfo { id: "upload", label: "Soltar arquivo", default_enabled: true, requires: &["claude"] },
    ModuleInfo { id: "timer", label: "Timer", default_enabled: false, requires: &[] },
    ModuleInfo { id: "voice", label: "Voz", default_enabled: false, requires: &["claude"] },
    ModuleInfo { id: "integrations", label: "Integrações", default_enabled: false, requires: &[] },
];

pub fn registry() -> Vec<Box<dyn Module>> {
    vec![Box::new(claude::Claude), Box::new(voice::Voice)] // M5 adds one entry per ported module
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
