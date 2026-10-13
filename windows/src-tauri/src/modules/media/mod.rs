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
        // The claude module's ingest emits this for every file that came onto the island.
        ctx.listen("media-note-drop", |ev| media::note_drop_event(ev.payload()));
        media::start(ctx);
    }

    fn stop(&self, _ctx: &ModuleCtx) {
        media::stop_watchers();
    }
}
