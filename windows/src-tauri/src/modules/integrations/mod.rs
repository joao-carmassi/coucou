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

pub use scheduler::{set_paused, wake};

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
}

/// The seven providers, in catalog order.
pub fn providers() -> Vec<Box<dyn Module>> {
    ["github", "vercel", "stripe", "n8n", "resend", "calcom", "notion"]
        .into_iter()
        .map(|short| Box::new(Provider { short }) as Box<dyn Module>)
        .collect()
}
