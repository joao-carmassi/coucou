// Coucou for Windows — app wiring and the commands the island calls.
// The cdylib/staticlib targets make MSVC print "Creating library ..." (localized), which rustc reports as a warning.
#![allow(linker_messages)]

mod core;
mod modules;

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use crate::core::host::{self, ModuleHost};
use crate::core::{island, log, platform, settings, tray};

use island::{PollGate, ScreenInfo};
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
    /// Section the settings window should scroll to. Kept until the window
    /// takes it, because the first-launch offer can fire before its page loads.
    pub settings_section: Mutex<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    modules: BTreeMap<String, bool>,
    safe_mode: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>, host: State<ModuleHost>) -> BootInfo {
    let settings = {
        let mut current = shared.settings.lock().unwrap();
        host.boot(&mut current);
        current.clone()
    };
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        cursor_poll: platform::CURSOR_POLL,
        modules: host.state(),
        safe_mode: core::safe_mode::active(),
    }
}

/// Merges `patch` (top-level keys, replaced whole) onto the stored settings under the lock, so two windows
/// saving different keys never undo each other. Keys the build does not know travel in `extra`.
#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, host: State<ModuleHost>, patch: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let (settings, screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let mut settings = match settings::merge_patch(&current, patch) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("[coucou] settings patch refused: {err}");
                return Err(format!("settings patch refused: {err}"));
            }
        };
        // A caller that does not know about modules must not wipe the switches.
        if settings.modules_enabled.is_empty() {
            settings.modules_enabled = current.modules_enabled.clone();
        }
        host.on_save(&current, &mut settings);
        // A changed switch map during safe mode is the user's choice: keep it (and leave safe mode) instead of losing it on exit.
        core::safe_mode::adopt(&mut settings.modules_enabled, &current.modules_enabled);
        settings.palette_hotkey = core::hotkeys::clean(&settings.palette_hotkey, settings::DEFAULT_PALETTE_HOTKEY);
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let screen_changed = screen_changed || current.island_placement != settings.island_placement;
        *current = settings.clone();
        // Saved inside the lock so two saves reach the disk in the order they were merged.
        if let Err(err) = settings::save(&settings) {
            eprintln!("[coucou] could not save settings: {err}");
        }
        (settings, screen_changed, autostart_changed)
    };
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // After the Shared lock is released: a module's start may need it.
    host.sync(&app, &settings);
    set_palette_hotkey(&app, &settings);
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

/// Hub backup: settings as pretty JSON, secret-looking keys removed, with the app version.
#[tauri::command]
fn settings_export(shared: State<Shared>) -> String {
    settings::export_json(&shared.settings.lock().unwrap(), env!("CARGO_PKG_VERSION"))
}

/// Hub banner button: the stored module switches replace the reduced ones, the marker is cleared and the host syncs.
#[tauri::command]
fn safe_mode_exit(app: AppHandle, shared: State<Shared>, host: State<ModuleHost>) -> bool {
    let settings = {
        let mut current = shared.settings.lock().unwrap();
        if !core::safe_mode::exit(&mut current.modules_enabled) {
            return false;
        }
        current.clone()
    };
    host.sync(&app, &settings);
    let _ = app.emit("settings-changed", settings);
    true
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64, compact: bool) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Only the compact island may hang the window past the display edge: re-place on change.
    if shared.gate.set_compact(compact) {
        let pref = shared.settings.lock().unwrap().screen.clone();
        island::apply_geometry(&app, &pref, shared.gate.collapsed.load(std::sync::atomic::Ordering::Relaxed));
    }
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    } else {
        platform::restore_foreground(&win);
    }
}

/// The palette hotkey remembered the focused window but the palette did not take the focus: forget it.
#[tauri::command]
fn forget_foreground() {
    platform::forget_foreground();
}

/// The palette's global hotkey ("" = off). Remembers the window that had the focus so closing the palette gives it back.
fn set_palette_hotkey(app: &AppHandle, s: &Settings) {
    let combo = core::hotkeys::clean(&s.palette_hotkey, settings::DEFAULT_PALETTE_HOTKEY);
    core::hotkeys::set(app, "palette", "Paleta", &combo, |a| {
        if let Some(win) = island::window(a) {
            platform::remember_foreground(&win);
        }
        let _ = a.emit_to(island::WINDOW_LABEL, "palette", ());
    });
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The cursor poll skips idle ticks: tell it the window moved under a still cursor.
    island::refresh_click_through(&app, &shared.gate);
}

/// Alt+press on the compact island: Rust follows the cursor until the button comes up.
#[tauri::command]
fn begin_island_drag(app: AppHandle) {
    island::begin_drag(&app);
}

/// The cursor reached the wake strip: true = a full-screen app is in front, the strip lets the mouse through.
#[tauri::command]
fn strip_pass_through(app: AppHandle) -> bool {
    island::strip_pass_through(&app)
}

#[tauri::command]
fn center_island(app: AppHandle, shared: State<Shared>) {
    island::adjust_placement(&app, &shared, None);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    core::safe_mode::clean_exit();
    app.exit(0);
}

/// Tray → Pause. Core polls nothing itself; each module parks what it runs.
#[tauri::command]
fn set_paused(host: State<ModuleHost>, paused: bool) {
    host.pause(paused);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
///
/// `CalculateNativeWinOcclusion` off: Chromium sometimes judges the transparent,
/// click-through island occluded at launch and marks the page hidden. Timers and
/// sounds keep running but requestAnimationFrame stops, so the island never
/// grows and never pushes its rect — heard, not seen, not clickable.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// Tauri's hide() does not tell WebView2 the page is hidden. While hidden, mark
/// the webview invisible and ask for a low memory target; restore both before
/// show(). Errors are ignored (older runtimes lack ICoreWebView2_19).
fn set_settings_webview_low(win: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core_062::Interface;
    let _ = win.with_webview(move |w| unsafe {
        let _ = w.controller().SetIsVisible(!low);
        if let Ok(core) = w.controller().CoreWebView2() {
            if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                let _ = core.SetMemoryUsageTargetLevel(if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                });
            }
        }
    });
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Configurações — Coucou")
        .inner_size(780.0, 680.0)
        .min_inner_size(620.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            set_settings_webview_low(&win, true);
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                    set_settings_webview_low(&hidden, true);
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    show_settings_section(app, "");
}

/// Shows the settings window and tells it which section to scroll to ("" for
/// none). The window also refreshes what is slow to compute on this cue.
pub(crate) fn show_settings_section(app: &AppHandle, section: &str) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    *app.state::<Shared>().settings_section.lock().unwrap() = section.to_string();
    set_settings_webview_low(&win, false);
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("settings", "settings-shown", ());
}

/// The section asked for by the last `show_settings_section`, once.
#[tauri::command]
fn take_settings_section(shared: State<Shared>) -> String {
    std::mem::take(&mut *shared.settings_section.lock().unwrap())
}


#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let (mut loaded, ok) = settings::load();
    let host = ModuleHost::new(modules::CATALOG, modules::registry());
    let migrated = host.migrate(&mut loaded);
    if migrated && ok {
        let _ = settings::save(&loaded);
    }
    let gate = Arc::new(PollGate::new());
    let core = host::handler(tauri::generate_handler![
        boot,
        save_settings,
        settings_export,
        safe_mode_exit,
        set_collapsed,
        set_island_rect,
        focus_window,
        forget_foreground,
        reposition,
        begin_island_drag,
        strip_pass_through,
        center_island,
        open_url,
        quit_app,
        log_line,
        open_settings_window,
        take_settings_section,
        set_paused,
        crate::core::inbox::inbox_ingest,
        crate::core::presence::presence_now,
        crate::core::presence::presence_watch,
    ]);
    let mods = modules::handlers();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(host)
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
            settings_section: Mutex::new(String::new()),
        })
        .invoke_handler(move |inv| {
            // Route by command-name prefix: a handler consumes the invoke, so they cannot be chained.
            let cmd = inv.message.command().to_string();
            match mods.iter().position(|(p, _)| p.iter().any(|p| cmd.starts_with(p))) {
                Some(i) => (mods[i].1)(inv),
                None => core(inv),
            }
        })
        .setup(move |app| {
            let mut loaded = loaded;
            let handle = app.handle().clone();
            // Here, not earlier: a second launch has already exited in the single-instance plugin.
            if core::safe_mode::begin(&loaded.modules_enabled) {
                log::line("[safe-mode] repeated unclean starts: only the safe set is on this run".to_string());
                let reduced: BTreeMap<String, bool> =
                    modules::CATALOG.iter().map(|m| (m.id.to_string(), modules::ESSENTIAL.contains(&m.id))).collect();
                loaded.modules_enabled = reduced.clone();
                handle.state::<Shared>().settings.lock().unwrap().modules_enabled = reduced;
            }
            handle.state::<ModuleHost>().setup(&handle);
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            // First run: the Hub opens on its onboarding (shown while onboardedVersion is empty).
            if loaded.onboarded_version.is_empty() {
                show_settings_window(&handle);
            }

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            handle.state::<ModuleHost>().sync(&handle, &loaded);
            set_palette_hotkey(&handle, &loaded);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Coucou")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                core::safe_mode::clean_exit();
            }
        });
}
