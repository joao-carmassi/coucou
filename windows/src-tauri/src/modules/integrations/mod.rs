// External services behind the island's pills: one module per service (github, vercel, stripe, n8n,
// resend, calcom, notion). This directory is their shared library, not a catalog entry: the
// fetchers, the secrets and ONE refcounted scheduler (scheduler.rs) that exists only while at least
// one provider module is on. A provider polls when it is on AND its keys are in the Credential Manager.

pub mod commands;
pub mod github;
pub mod github_detail;
pub mod integrations;
pub mod scheduler;
pub mod secrets;

pub use scheduler::wake;

use crate::core::host::{Module, ModuleCtx};
use crate::core::settings::Settings;

/// One service as a module; `short` is the module id (the pill/task id is `integration_<short>`).
pub struct Provider {
    pub short: &'static str,
}

impl Module for Provider {
    fn id(&self) -> &'static str {
        self.short
    }

    fn start(&self, ctx: &ModuleCtx, _s: &Settings) {
        scheduler::enable(&ctx.app, self.short);
    }

    fn stop(&self, _ctx: &ModuleCtx) {
        scheduler::disable(self.short);
    }

    /// Pre-module settings.json: on when `activeIntegrations` listed `integration_<short>`.
    fn migrate(&self, s: &mut Settings) -> bool {
        if s.modules_enabled.contains_key(self.short) {
            return false;
        }
        let id = format!("integration_{}", self.short);
        let listed = s
            .extra
            .get("activeIntegrations")
            .and_then(|v| v.as_array())
            .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(&id)));
        // m7 era: the master switch was explicitly off, so the listed providers stay off.
        let off = s.modules_enabled.get("integrations") == Some(&false);
        s.modules_enabled.insert(self.short.into(), listed && !off);
        true
    }

    fn pause(&self, paused: bool) {
        // A static flag: set even with the provider off, so enabling it later starts right.
        scheduler::set_paused(paused);
    }
}

/// The seven providers, in catalog order.
pub fn providers() -> Vec<Box<dyn Module>> {
    ["github", "vercel", "stripe", "n8n", "resend", "calcom", "notion"]
        .into_iter()
        .map(|short| Box::new(Provider { short }) as Box<dyn Module>)
        .collect()
}

pub const PREFIXES: &[&str] = &["integrations_", "github_", "n8n_"];

pub fn modules() -> Vec<Box<dyn Module>> {
    providers()
}

pub fn handler() -> crate::core::host::Handler {
    use commands::*;
    crate::core::host::handler(tauri::generate_handler![
        integrations_secret_present, integrations_secret_set, integrations_secret_clear, github_test, github_project,
        github_day, github_detail, n8n_open, integrations_refresh,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_from_active_integrations() {
        let mut s: Settings = serde_json::from_str(
            r#"{"activeIntegrations":["integration_github","integration_vercel","integration_notion"],"modulesEnabled":{"notion":false}}"#,
        )
        .unwrap();
        for p in ["github", "vercel", "stripe", "notion"] {
            Provider { short: p }.migrate(&mut s);
        }
        for (id, on) in [("github", true), ("vercel", true), ("stripe", false), ("notion", false)] {
            assert_eq!(s.module_on(id, !on), on, "{id}");
        }
        assert!(!Provider { short: "github" }.migrate(&mut s), "idempotent");
    }

    #[test]
    fn migrate_master_off_keeps_providers_off() {
        let mut s: Settings = serde_json::from_str(
            r#"{"activeIntegrations":["integration_github"],"modulesEnabled":{"integrations":false}}"#,
        )
        .unwrap();
        Provider { short: "github" }.migrate(&mut s);
        assert!(!s.module_on("github", true));
    }
}
