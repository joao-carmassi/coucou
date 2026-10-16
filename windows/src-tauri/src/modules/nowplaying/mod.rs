// Tocando agora: what the PC is playing (Windows media session: title, artist, cover, play/pause/next/previous,
// progress) and, only while the island asks for it, the spectrum of the output (WASAPI loopback + FFT).
// Privacy: the sound is analysed in memory and dropped; nothing is stored or sent; the microphone is never opened.

pub mod analyze;
pub mod loopback;
pub mod session;
pub mod volume;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::core::host::{blocking, Module, ModuleCtx, Spawner};
use crate::core::settings::Settings;
use session::{Action, Msg, Snapshot};

pub struct NowPlaying;

/// Spawn rights, the worker's channel and the running capture's off switch; all empty while the module is off.
static SPAWNER: Mutex<Option<Spawner>> = Mutex::new(None);
static TX: Mutex<Option<Sender<Msg>>> = Mutex::new(None);
static CAPTURE: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

impl Module for NowPlaying {
    fn id(&self) -> &'static str {
        "nowplaying"
    }

    fn start(&self, ctx: &ModuleCtx, _s: &Settings) {
        let (tx, rx) = channel();
        *TX.lock().unwrap() = Some(tx.clone());
        *SPAWNER.lock().unwrap() = Some(ctx.spawner());
        let app = ctx.app.clone();
        ctx.spawn(move |_| session::run(&app, tx, rx));
    }

    fn stop(&self, ctx: &ModuleCtx) {
        set_capture(&ctx.app, false);
        if let Some(tx) = TX.lock().unwrap().take() {
            let _ = tx.send(Msg::Quit); // the worker is blocked on the channel
        }
        SPAWNER.lock().unwrap().take();
    }
}

/// Starts or stops the loopback thread. Idempotent; a no-op while the module is off.
fn set_capture(app: &AppHandle, on: bool) {
    let mut cur = CAPTURE.lock().unwrap();
    if !on {
        if let Some(off) = cur.take() {
            off.store(true, Ordering::SeqCst);
        }
        return;
    }
    if cur.is_some() {
        return;
    }
    let Some(spawner) = SPAWNER.lock().unwrap().clone() else { return };
    let off = Arc::new(AtomicBool::new(false));
    *cur = Some(off.clone());
    let app = app.clone();
    spawner.spawn(move |stop| loopback::run(&app, &stop, &off));
}

/// The last state the media session reported (the view asks when it opens); None when nothing is on.
#[tauri::command]
pub fn nowplaying_state() -> Option<Snapshot> {
    session::LAST.lock().unwrap().clone()
}

/// "toggle" | "next" | "prev" on the current player.
#[tauri::command]
pub fn nowplaying_control(action: String) -> Result<(), String> {
    let a: Action = session::parse_action(&action).ok_or_else(|| format!("ação desconhecida: {action}"))?;
    let tx = TX.lock().unwrap().clone().ok_or("O módulo Tocando agora está desligado nas Configurações.")?;
    tx.send(Msg::Control(a)).map_err(|e| e.to_string())
}

/// Spectrum capture on/off: the island asks only while something plays AND the Mochi dance or the view is on screen.
#[tauri::command]
pub fn nowplaying_capture(app: AppHandle, on: bool) {
    set_capture(&app, on);
}

/// 0..1 volume of the player's audio session (matched by exe name, see volume.rs); None when it has no session.
#[tauri::command]
pub async fn nowplaying_volume_get() -> Result<Option<f32>, String> {
    let id = session::LAST.lock().unwrap().as_ref().map(|s| s.app_id.clone()).unwrap_or_default();
    if id.is_empty() {
        return Ok(None);
    }
    blocking(move || volume::get(&id)).await?
}

/// Sets the player's volume (0..1); returns false when no audio session matched.
#[tauri::command]
pub async fn nowplaying_volume_set(level: f32) -> Result<bool, String> {
    let id = session::LAST.lock().unwrap().as_ref().map(|s| s.app_id.clone()).unwrap_or_default();
    if id.is_empty() {
        return Ok(false);
    }
    Ok(blocking(move || volume::set(&id, level)).await?? > 0)
}

pub const PREFIXES: &[&str] = &["nowplaying_"];

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(NowPlaying)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![
        nowplaying_state, nowplaying_control, nowplaying_capture, nowplaying_volume_get, nowplaying_volume_set,
    ])
}
