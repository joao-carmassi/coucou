// Mídia: the list of screenshots and dropped files, and window captures.

pub mod capture;
pub mod commands;
pub mod media;

use crate::core::host::{Module, ModuleCtx};
use crate::core::settings::Settings;

pub struct Media;

impl Module for Media {
    fn id(&self) -> &'static str {
        "media"
    }

    fn start(&self, ctx: &ModuleCtx, _s: &Settings) {
        // core::inbox emits this for every file that came onto the island.
        ctx.listen("inbox-added", |ev| media::note_drop_event(ev.payload()));
        media::start(ctx);
    }

    fn stop(&self, _ctx: &ModuleCtx) {
        media::stop_watchers();
    }
}

pub const PREFIXES: &[&str] = &["media_"];

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Media)]
}

pub fn handler() -> crate::core::host::Handler {
    use commands::*;
    crate::core::host::handler(tauri::generate_handler![
        media_attach_window, media_list, media_thumb, media_open, media_open_with, media_reveal, media_remove,
    ])
}
