// Feature modules. The host (core/host.rs) starts and stops them from settings.

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
    vec![] // M5 adds one entry per ported module
}
