// Voice input: a global hotkey toggles the microphone, the recording is transcribed on the
// device (English engine, or whisper.cpp for several languages) and shown on a card; "Enviar" (in the UI) launches a Claude session with it.

pub mod cfg;
pub mod flow;
pub mod voice;
pub mod whisper;

use tauri::AppHandle;

use crate::core::host::{Module, ModuleCtx};
use crate::core::hotkeys;
use crate::core::settings::Settings;

pub struct Voice;

impl Module for Voice {
    fn id(&self) -> &'static str {
        "voice"
    }

    fn start(&self, ctx: &ModuleCtx, s: &Settings) {
        voice::configure(s);
        set_hotkey(&ctx.app, s);
        flow::set(ctx, cfg::flow_enabled(s));
    }

    fn migrate(&self, s: &mut Settings) -> bool {
        cfg::migrate(s)
    }

    fn on_save(&self, _current: &Settings, incoming: &mut Settings) {
        cfg::mirror_legacy(incoming);
    }

    fn apply(&self, ctx: &ModuleCtx, s: &Settings) {
        voice::configure(s);
        set_hotkey(&ctx.app, s);
        flow::set(ctx, cfg::flow_enabled(s));
    }

    fn stop(&self, ctx: &ModuleCtx) {
        hotkeys::clear(&ctx.app, "voice");
        flow::set(ctx, false); // removes the keyboard hook
        voice::stop(); // the capture loop ends within 30 ms and closes the microphone
    }
}

fn set_hotkey(app: &AppHandle, s: &Settings) {
    let combo = hotkeys::clean(&cfg::hotkey(s), cfg::DEFAULT_HOTKEY);
    hotkeys::set(app, "voice", "Voz", &combo, voice::on_hotkey);
}

pub const PREFIXES: &[&str] = &["voice_"];

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Voice)]
}

pub fn handler() -> crate::core::host::Handler {
    use voice::*;
    crate::core::host::handler(tauri::generate_handler![voice_start, voice_stop, voice_cancel, voice_model_status, voice_download_model, voice_download_whisper])
}
