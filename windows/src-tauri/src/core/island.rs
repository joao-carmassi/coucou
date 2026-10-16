// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::core::platform::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
    pub down: bool,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
    /// Island geometry / ignore state changed: the poll must re-evaluate even
    /// though the cursor stands still.
    recheck: AtomicBool,
    /// The front end shows the compact island (the only view that may overshoot the display edge).
    compact: AtomicBool,
    /// A native Alt-drag is running (at most one).
    dragging: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
            recheck: AtomicBool::new(true),
            compact: AtomicBool::new(false),
            dragging: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
        self.recheck.store(true, Ordering::Relaxed);
    }

    /// Returns true when the flag changed (the window must then be placed again).
    pub fn set_compact(&self, on: bool) -> bool {
        self.compact.swap(on, Ordering::Relaxed) != on
    }

    /// Logical px the window may hang past each display edge so the compact island
    /// itself can sit flush with it.
    fn overshoot(&self, collapsed: bool) -> f64 {
        if collapsed || !self.compact.load(Ordering::Relaxed) { return 0.0 }
        overshoot_logical(self.rect.lock().unwrap().w)
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
        self.recheck.store(true, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Stable id of a display for per-display placement: "<name>:<w>x<h>" in physical pixels.
pub fn monitor_key(name: Option<&str>, w: u32, h: u32) -> String {
    format!("{}:{}x{}", name.unwrap_or(""), w, h)
}

/// Left edge of a window `panel_w` wide: centred on the display, moved by `dx_phys`,
/// then kept fully inside it (a stale offset can never strand the island).
#[cfg(test)]
pub fn place_x(mon_x: i32, mon_w: u32, panel_w: u32, dx_phys: i32) -> i32 {
    place_x_over(mon_x, mon_w, panel_w, dx_phys, 0)
}

/// `place_x` that lets the window hang `over` physical px past either display edge.
pub fn place_x_over(mon_x: i32, mon_w: u32, panel_w: u32, dx_phys: i32, over: i32) -> i32 {
    let lo = mon_x as i64;
    let hi = (lo + mon_w as i64 - panel_w as i64).max(lo);
    let want = lo + (mon_w as i64 - panel_w as i64) / 2 + dx_phys as i64;
    want.clamp(lo - over as i64, hi + over as i64) as i32
}

/// Island width assumed before the front end has pushed its rect.
const DEFAULT_ISLAND_W: f64 = 200.0;

/// Slack on each side of a compact island of width `w` inside the panel window.
pub fn overshoot_logical(w: f64) -> f64 {
    let w = if w > 0.0 { w } else { DEFAULT_ISLAND_W };
    ((PANEL_W - w) / 2.0).max(0.0)
}

/// Cursor travel before a press counts as a drag, in physical px.
const DRAG_SLOP: f64 = 5.0;

/// Stored-offset change (logical px) for a cursor that went from `start` to `now` (physical px).
pub fn drag_delta_logical(start: f64, now: f64, scale: f64) -> f64 {
    (now - start) / scale
}

/// Adds `d` to the stored offset for `key`, limited to +-`limit`; zero removes the entry.
fn add_offset(map: &mut std::collections::BTreeMap<String, f64>, key: &str, d: f64, limit: f64) {
    let v = (map.get(key).copied().unwrap_or(0.0) + d).clamp(-limit, limit);
    if v == 0.0 { map.remove(key); } else { map.insert(key.to_string(), v); }
}

/// Moves the island by `dx` logical px on the current display (None = back to the centre),
/// saves under the settings lock like `save_settings`, and places the window again.
pub fn adjust_placement(app: &AppHandle, shared: &crate::Shared, dx: Option<f64>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let Some(m) = target_monitor(app, &pref) else { return };
    let size = *m.size();
    let key = monitor_key(m.name().map(String::as_str), size.width, size.height);
    let fresh = {
        let mut s = shared.settings.lock().unwrap();
        match dx {
            Some(d) if d.is_finite() => {
                // Same bound `place_x` applies to the full panel: stored offsets never pile up past the edge.
                let limit = ((size.width as f64 / m.scale_factor() - PANEL_W) / 2.0).max(0.0)
                    + shared.gate.overshoot(false);
                add_offset(&mut s.island_placement, &key, d, limit);
            }
            Some(_) => return,
            None => { s.island_placement.remove(&key); }
        }
        if let Err(err) = crate::core::settings::save(&s) {
            eprintln!("[coucou] could not save settings: {err}");
        }
        s.clone()
    };
    let _ = app.emit("settings-changed", fresh);
    apply_geometry(app, &pref, shared.gate.collapsed.load(Ordering::Relaxed));
    refresh_click_through(app, &shared.gate);
}

/// Alt-drag, run natively: a thread follows the global cursor at ~120 Hz and moves the
/// window itself, so no IPC and no front-end frame sits between hand and island.
/// It exists only while the button is held; the release commits like `set_island_offset`.
pub fn begin_drag(app: &AppHandle) {
    let shared = app.state::<crate::Shared>();
    if shared.gate.dragging.swap(true, Ordering::SeqCst) { return }
    let app = app.clone();
    std::thread::spawn(move || {
        let moved = run_drag(&app);
        let shared = app.state::<crate::Shared>();
        match moved {
            Some(dx) => adjust_placement(&app, &shared, Some(dx)),
            None => {
                // Never became a drag, or the display changed: window back where the settings say.
                let pref = shared.settings.lock().unwrap().screen.clone();
                apply_geometry(&app, &pref, shared.gate.collapsed.load(Ordering::Relaxed));
                refresh_click_through(&app, &shared.gate);
            }
        }
        shared.gate.dragging.store(false, Ordering::SeqCst);
        let _ = app.emit_to(WINDOW_LABEL, "island-drag-end", moved.is_some());
    });
}

/// The drag loop. Returns the logical dx to commit, or None.
fn run_drag(app: &AppHandle) -> Option<f64> {
    let shared = app.state::<crate::Shared>();
    let pref = shared.settings.lock().unwrap().screen.clone();
    let win = window(app)?;
    let m = target_monitor(app, &pref)?;
    let (scale, mp, ms) = (m.scale_factor(), *m.position(), *m.size());
    let key = monitor_key(m.name().map(String::as_str), ms.width, ms.height);
    let base = shared.settings.lock().unwrap().island_placement.get(&key).copied().unwrap_or(0.0);
    let pw = (PANEL_W * scale).round().max(1.0) as u32;
    let over = (shared.gate.overshoot(false) * scale).round() as i32;
    let screen = current_screen_key(app);
    let (sx, _) = cursor_physical()?;
    let (mut last_cx, mut moved, mut last_x, mut tick) = (sx, false, i32::MIN, 0u32);
    while left_button_down() {
        std::thread::sleep(Duration::from_millis(8));
        tick += 1;
        if tick % 60 == 0 && current_screen_key(app) != screen { return None }
        let Some((cx, _)) = cursor_physical() else { break };
        last_cx = cx;
        if !moved && (cx - sx).abs() <= DRAG_SLOP * scale { continue }
        moved = true;
        let want = (base * scale).round() as i32 + (cx - sx).round() as i32;
        let x = place_x_over(mp.x, ms.width, pw, want, over);
        if x != last_x {
            last_x = x;
            let _ = win.set_position(PhysicalPosition::new(x, mp.y));
        }
    }
    moved.then(|| drag_delta_logical(sx, last_cx, scale))
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;
    let dx = app
        .try_state::<crate::Shared>()
        .and_then(|sh| {
            let key = monitor_key(m.name().map(String::as_str), ms.width, ms.height);
            sh.settings.lock().unwrap().island_placement.get(&key).copied()
        })
        .unwrap_or(0.0);
    let over = app
        .try_state::<crate::Shared>()
        .map(|sh| (sh.gate.overshoot(collapsed) * scale).round() as i32)
        .unwrap_or(0);
    let x = place_x_over(mp.x, ms.width, pw, (dx * scale).round() as i32, over);
    let y = mp.y;

    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        let mut pressed_outside = false;
        let mut pressed_on_island = false;
        let mut shielded = false;
        let mut file_drag_seen = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            let mut last_phys: Option<(f64, f64)> = None;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::core::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                // Cheap gate: cursor and button are plain Win32 reads, while the window
                // getters below are main-thread round-trips. Nothing moved, no button
                // edge, not the periodic 30th tick and no geometry/ignore-state change
                // flagged via `recheck` → nothing to re-evaluate.
                let Some((cx, cy)) = cursor_physical() else { continue };
                let down_now = left_button_down();
                let recheck = gate.recheck.swap(false, Ordering::Relaxed);
                if !recheck
                    && ticks % 30 != 0
                    && down_now == was_down
                    && last_phys == Some((cx, cy))
                {
                    continue;
                }
                last_phys = Some((cx, cy));

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                // A button edge is handled even when the cursor stands still: a drag
                // abandoned elsewhere usually ends that way, and the release has to
                // reach the drag logic below (shield off, "file-drag" end).
                let down = down_now;
                if down == was_down && (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                // A press may be the start of a drag: make sure the drop target is
                // ours before the file arrives.
                let was_down_before = was_down;
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                // A button pressed *outside* the panel and still held over it is a
                // drag from elsewhere — a file, not a click. The window under the
                // cursor is then WebView2's, in another process, and OLE never
                // reaches the drop target on our windows above it. Disabling our
                // webview host window for the length of the drag makes Windows
                // skip that whole subtree, so the hit lands on WRY_WEBVIEW, which
                // carries our own drop target (drop_target.rs). Released → back.
                if down && !was_down_before {
                    pressed_outside = !(x >= 0.0 && x <= size.0 && y >= 0.0 && y <= size.1);
                    pressed_on_island = on_island;
                }
                // A press inside the panel but off the island went to the window
                // underneath (we were click-through) — a title-bar button, say.
                // Taking the mouse mid-click sends that window a mouse-leave and
                // its button cancels the click, so it keeps the mouse unless the
                // drag actually reaches the island.
                let pressed_under = !pressed_outside && !pressed_on_island;
                let dragging = dragging && (!pressed_under || on_island);
                let file_drag = dragging && !pressed_on_island;
                if file_drag != shielded {
                    shielded = file_drag;
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        platform::shield_webview(&handle, file_drag)
                    });
                }
                // The drag is over once the button comes up. A drop has already
                // been delivered by then; anything else (released elsewhere, Esc)
                // must not leave the island waiting for a file that never comes.
                if file_drag {
                    file_drag_seen = true;
                } else if !down && file_drag_seen {
                    file_drag_seen = false;
                    let _ = app.emit_to(WINDOW_LABEL, "file-drag", serde_json::json!({ "type": "end" }));
                }

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y, down });
            }

            // Parked: the window is (or is about to be) the wake strip, which must
            // take the mouse. The tick that was running when the island collapsed
            // may just have made it click-through, and setters from this thread are
            // queued to the event loop — so clear the flag from here, behind it.
            // Otherwise the hidden island can only be woken by module events.
            if let Some(win) = window(&app) {
                let _ = win.set_ignore_cursor_events(false);
            }
            gate.forget_ignore_state();
        }
    });
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        None
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region);
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_name_and_physical_size() {
        assert_eq!(monitor_key(Some("DP-1"), 2560, 1440), "DP-1:2560x1440");
        assert_eq!(monitor_key(None, 1920, 1080), ":1920x1080");
    }

    #[test]
    fn place_x_centres_and_clamps() {
        assert_eq!(place_x(0, 1920, 720, 0), 600);
        assert_eq!(place_x(0, 1920, 720, 100), 700);
        assert_eq!(place_x(0, 1920, 720, -5000), 0);
        assert_eq!(place_x(0, 1920, 720, 5000), 1200);
        // display left of the origin
        assert_eq!(place_x(-1920, 1920, 720, 0), -1320);
        assert_eq!(place_x(-1920, 1920, 720, -9999), -1920);
        assert_eq!(place_x(-1920, 1920, 720, 9999), -720);
        // panel wider than the display: pinned to its left edge
        assert_eq!(place_x(10, 500, 720, 50), 10);
    }

    #[test]
    fn overshoot_lets_compact_reach_the_edge_expanded_stays_inside() {
        // 720 window, 200 island: 260 px of slack each side
        let over = overshoot_logical(200.0) as i32;
        assert_eq!(over, 260);
        assert_eq!(place_x_over(0, 1920, 720, -5000, over), -260);
        assert_eq!(place_x_over(0, 1920, 720, 5000, over), 1460);
        // island flush left: window x -260 puts the island at 0
        assert_eq!(-260 + (720 - 200) / 2, 0);
        // expanded: no overshoot, same as place_x
        assert_eq!(place_x_over(0, 1920, 720, -5000, 0), 0);
        assert_eq!(place_x_over(0, 1920, 720, 5000, 0), 1200);
        assert_eq!(place_x_over(-1920, 1920, 720, -9999, over), -2180);
        // unknown width falls back to a constant; a full-width island has no slack
        assert_eq!(overshoot_logical(0.0), 260.0);
        assert_eq!(overshoot_logical(720.0), 0.0);
    }

    #[test]
    fn drag_delta_is_cursor_travel_in_logical_px() {
        assert_eq!(drag_delta_logical(1000.0, 1300.0, 1.0), 300.0);
        assert_eq!(drag_delta_logical(1000.0, 700.0, 1.5), -200.0);
        assert_eq!(drag_delta_logical(500.0, 500.0, 2.0), 0.0);
    }

    #[test]
    fn offsets_add_clamp_and_clear() {
        let mut m = std::collections::BTreeMap::new();
        add_offset(&mut m, "a", 30.0, 100.0);
        add_offset(&mut m, "a", 50.0, 100.0);
        assert_eq!(m["a"], 80.0);
        add_offset(&mut m, "a", 50.0, 100.0);
        assert_eq!(m["a"], 100.0);
        add_offset(&mut m, "a", -100.0, 100.0);
        assert!(m.is_empty());
    }
}
