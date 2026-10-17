// The companion: Mochi in a small floating window of his own (core feature, not a module).
// The window exists only while `companionEnabled` is on: built on the main thread when it comes on,
// destroyed when it goes off, so an off companion costs no webview and no memory.
// The island pushes what Mochi wears (`companion-avatar`); the page draws it and decides when to
// run frames (see src/companion). Outside Mochi's body the window is click-through at the OS level
// (a window region), so there is no cursor polling.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::core::{island, log, platform, settings::Settings};

pub const LABEL: &str = "companion";
/// Logical px (square).
const SIZE: f64 = 180.0;
/// Body hit area inside the window, logical px: x, y, w, h (the ellipse the mouse can grab).
const HIT: (f64, f64, f64, f64) = (5.0, 0.0, 170.0, 180.0);
/// Dropping the companion this close to the island's top centre docks it back (logical px).
const DOCK_RADIUS: f64 = 80.0;

/// A build is queued on the main thread (no second one meanwhile).
static BUILDING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Keeps a `size` square window at `pos` fully on a display. The display holding its centre wins;
/// a centre on no display (a removed monitor) goes to `monitors[0]`, the primary.
pub fn clamp(pos: (i32, i32), size: i32, monitors: &[Rect]) -> (i32, i32) {
    let Some(first) = monitors.first() else { return pos };
    let (cx, cy) = (pos.0 + size / 2, pos.1 + size / 2);
    let m = monitors
        .iter()
        .find(|m| cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h)
        .unwrap_or(first);
    (
        pos.0.clamp(m.x, (m.x + m.w - size).max(m.x)),
        pos.1.clamp(m.y, (m.y + m.h - size).max(m.y)),
    )
}

/// Bottom-right corner of `m`, above the taskbar.
fn default_pos(m: &Rect, size: i32) -> (i32, i32) {
    (m.x + m.w - size - 40, m.y + m.h - size - 80)
}

/// True when `center` (window centre) is within `radius` of the `dock` point.
pub fn near_dock(center: (f64, f64), dock: (f64, f64), radius: f64) -> bool {
    (center.0 - dock.0).hypot(center.1 - dock.1) <= radius
}

fn monitors(app: &AppHandle) -> Vec<Rect> {
    let rect = |m: &tauri::Monitor| Rect { x: m.position().x, y: m.position().y, w: m.size().width as i32, h: m.size().height as i32 };
    let mut all: Vec<Rect> = app.available_monitors().unwrap_or_default().iter().map(rect).collect();
    if let Ok(Some(p)) = app.primary_monitor() {
        let p = rect(&p);
        all.retain(|m| *m != p);
        all.insert(0, p); // primary first: clamp() sends a lost window there
    }
    all
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/companion.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("companion.html".into())
}

/// Sizes the window and its hit region for the display it is on now; returns the physical side.
fn fit_scale(win: &tauri::WebviewWindow) -> i32 {
    let scale = win.scale_factor().unwrap_or(1.0);
    let px = |v: f64| (v * scale).round() as i32;
    let side = px(SIZE);
    if win.outer_size().is_ok_and(|s| s.width as i32 != side || s.height as i32 != side) {
        let _ = win.set_size(tauri::PhysicalSize::new(side as u32, side as u32));
    }
    platform::set_hit_ellipse(win, px(HIT.0), px(HIT.1), px(HIT.2), px(HIT.3));
    side
}

/// Builds the window hidden (the page shows it once it has something to draw: no white flash).
fn build(app: &AppHandle, pos: &BTreeMap<String, f64>) {
    // Turned off while this build waited for the main thread: build nothing.
    if !app.state::<crate::Shared>().settings.lock().unwrap().companion_enabled {
        return;
    }
    let built = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(SIZE, SIZE)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build();
    let win = match built {
        Ok(w) => w,
        Err(err) => return log::line(format!("companion window failed: {err}")),
    };
    platform::make_non_activating(&win);
    let size = fit_scale(&win);
    let mons = monitors(app);
    let want = match (pos.get("x"), pos.get("y"), mons.first()) {
        (Some(&x), Some(&y), _) if x.is_finite() && y.is_finite() => (x as i32, y as i32),
        (_, _, Some(p)) => default_pos(p, size),
        _ => (100, 100),
    };
    let (x, y) = clamp(want, size, &mons);
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Boot and every settings save: creates or destroys the window to match `companionEnabled`. Safe to repeat.
pub fn sync(app: &AppHandle, s: &Settings) {
    let exists = app.get_webview_window(LABEL).is_some();
    if s.companion_enabled && !exists {
        if BUILDING.swap(true, Ordering::SeqCst) {
            return;
        }
        let (a, pos) = (app.clone(), s.companion_pos.clone());
        let _ = app.run_on_main_thread(move || {
            build(&a, &pos);
            BUILDING.store(false, Ordering::SeqCst);
        });
    } else if !s.companion_enabled && exists {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Turned on again while this waited for the main thread: keep the window.
            if a.state::<crate::Shared>().settings.lock().unwrap().companion_enabled {
                return;
            }
            if let Some(w) = a.get_webview_window(LABEL) {
                let _ = w.destroy();
            }
        });
    }
}

/// The page shows or hides the window: hidden while the island would be hidden (a full-screen app, a call) or paused.
#[tauri::command]
pub fn companion_visible(app: AppHandle, visible: bool) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let _ = if visible { w.show() } else { w.hide() };
}

/// After a drag: saves the position, or docks the companion back when it was dropped by the island.
#[tauri::command]
pub fn companion_moved(app: AppHandle, shared: State<crate::Shared>) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    fit_scale(&w); // dropped on a display with another scale
    let (Ok(p), Ok(sz)) = (w.outer_position(), w.outer_size()) else { return };
    let docked = island::window(&app).is_some_and(|i| {
        let (Ok(ip), Ok(isz)) = (i.outer_position(), i.outer_size()) else { return false };
        let scale = w.scale_factor().unwrap_or(1.0);
        near_dock(
            (p.x as f64 + sz.width as f64 / 2.0, p.y as f64 + sz.height as f64 / 2.0),
            (ip.x as f64 + isz.width as f64 / 2.0, ip.y as f64),
            DOCK_RADIUS * scale,
        )
    });
    let fresh = {
        let mut s = shared.settings.lock().unwrap();
        if docked {
            s.companion_enabled = false;
        } else {
            s.companion_pos = BTreeMap::from([("x".to_string(), p.x as f64), ("y".to_string(), p.y as f64)]);
        }
        if let Err(err) = crate::core::settings::save(&s) {
            eprintln!("[coucou] could not save settings: {err}");
        }
        s.clone()
    };
    if docked {
        let _ = app.emit("settings-changed", fresh.clone());
        sync(&app, &fresh);
    }
}

/// A click on Mochi in his window: the island comes back (the same cue as the tray's "open").
#[tauri::command]
pub fn companion_click(app: AppHandle) {
    let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };
    const B: Rect = Rect { x: 1920, y: 0, w: 1280, h: 1024 };

    #[test]
    fn inside_stays() {
        assert_eq!(clamp((100, 100), 180, &[A, B]), (100, 100));
        assert_eq!(clamp((2000, 50), 180, &[A, B]), (2000, 50));
    }

    #[test]
    fn edge_is_pulled_in_on_its_own_display() {
        assert_eq!(clamp((1900, 1000), 180, &[A, B]), (1740, 900));
        assert_eq!(clamp((-50, -50), 180, &[A, B]), (0, 0));
    }

    #[test]
    fn removed_monitor_goes_to_primary() {
        // Was on B (x 2500); only A is left.
        assert_eq!(clamp((2500, 300), 180, &[A]), (1740, 300));
        assert_eq!(clamp((100, 100), 180, &[]), (100, 100), "no display info: unchanged");
    }

    #[test]
    fn dock_radius() {
        assert!(near_dock((960.0, 60.0), (960.0, 0.0), 80.0));
        assert!(!near_dock((960.0, 200.0), (960.0, 0.0), 80.0));
    }

    #[test]
    fn default_corner_is_on_screen() {
        let (x, y) = default_pos(&A, 180);
        assert_eq!(clamp((x, y), 180, &[A]), (x, y));
    }
}
