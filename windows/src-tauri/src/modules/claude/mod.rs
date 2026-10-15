// Claude Code: the hook relay, sessions, and the terminals they run in.

pub mod cfg;
pub mod commands;
pub mod focus;
pub mod hooks;
pub mod local_claude;
pub mod pipe;
pub mod sessions;
pub mod wsl;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::core::host::{Module, ModuleCtx};
use crate::core::settings::{self, Settings};
use crate::core::{hotkeys, log, relay};

pub struct Claude;

impl Module for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn start(&self, ctx: &ModuleCtx, s: &Settings) {
        hooks::ensure_hook_exe(&ctx.app);
        relay::subscribe(ctx, pipe::CHANNEL);
        set_alert(ctx, s);
        let app = ctx.app.clone();
        ctx.spawn(move |stop| offer_wsl_setup(&app, &stop));
    }

    fn apply(&self, ctx: &ModuleCtx, s: &Settings) {
        set_alert(ctx, s);
    }

    fn on_save(&self, current: &Settings, incoming: &mut Settings) {
        cfg::on_save(current, incoming);
    }

    fn boot(&self, s: &mut Settings) {
        cfg::refresh_hooks_installed(s);
    }

    fn stop(&self, ctx: &ModuleCtx) {
        hotkeys::clear(&ctx.app, "alert");
    }
}

fn set_alert(ctx: &ModuleCtx, s: &Settings) {
    let combo = hotkeys::clean(&cfg::alert_hotkey(s), "");
    hotkeys::set(&ctx.app, "alert", "Ir ao alerta", &combo, |a| {
        let _ = a.emit("go-to-alert", ());
    });
}

/// First launch after installing: if WSL has distros and none is hooked up yet, open the settings on
/// the WSL section. Offered once; nothing is written until the user reviews the diff and clicks.
fn offer_wsl_setup(app: &AppHandle, stop: &AtomicBool) {
    let shared = app.state::<crate::Shared>();
    {
        let current = shared.settings.lock().unwrap();
        if cfg::wsl_prompted(&current) || !cfg::wsl_hooks(&current).is_empty() {
            return;
        }
    }
    if wsl::distros().is_empty() || stop.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut current = shared.settings.lock().unwrap();
        cfg::set_wsl_prompted(&mut current, true);
        let _ = settings::save(&current);
    }
    log::line("WSL detected — offering to set up its Claude Code hooks");
    crate::show_settings_section(app, "wsl");
}

pub const PREFIXES: &[&str] = &["claude_"];

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Claude)]
}

pub fn handler() -> crate::core::host::Handler {
    use commands::*;
    crate::core::host::handler(tauri::generate_handler![
        claude_open_app, claude_open_in_vscode, claude_open_terminal, claude_start_terminal, claude_resume_in_terminal,
        claude_profiles, claude_sessions_all, claude_sessions_live, claude_session_launch, claude_session_erase,
        claude_hooks_status, claude_hooks_preview, claude_hooks_apply, claude_wsl_distros, claude_wsl_status,
        claude_wsl_hooks_preview, claude_wsl_hooks_apply, claude_approval_decision, claude_approval_ack,
        claude_approval_decline, claude_approval_answer,
    ])
}
