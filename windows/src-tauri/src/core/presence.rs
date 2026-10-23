// Presence: is the user busy (a full-screen app, a presentation, quiet hours, a call)?
//
// `now()` reads three cheap OS answers: SHQueryUserNotificationState, whether the foreground window is a
// borderless window covering its whole monitor (a "full-screen window" game or video, which the first one
// misses), and the microphone consent registry (an app using the mic has LastUsedTimeStop == 0). Never window titles.
//
// Watching: one shared WinEventHook thread (EVENT_SYSTEM_FOREGROUND), refcounted. It exists only while
// subscribers > 0 and is stopped like `hotkeys::quit_thread`. Idle cost: one thread blocked in GetMessageW
// (no CPU, no polling); the OS wakes it once per foreground change, which re-reads the answers
// (well under a millisecond) and emits `presence` only when the value changed. A game often takes the
// foreground before it fills the screen, so the island's answer is read once more RECHECK_MS later (a one-shot
// thread timer, re-armed by each foreground change).
// The island watches while it is visible (and while a notice waits) with "hide when busy" on: one blocked hook
// thread whenever the island is visible, none when it is hidden or the setting is off.
// A crashed app can leave LastUsedTimeStop == 0 in the registry: such a use older than 12 h is ignored
// (STALE_USE), so quiet is not stuck forever.
// Not covered: Focus Assist, and a change that does not move the foreground (a call that starts in the app
// already in front is seen at the next foreground change or the next `presence_watch(true)`).

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE,
};
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, KillTimer,
    PeekMessageW, PostThreadMessageW, SetTimer, EVENT_SYSTEM_FOREGROUND, GWL_STYLE, MSG, PM_NOREMOVE, WINEVENT_OUTOFCONTEXT,
    WM_QUIT, WM_TIMER, WM_USER, WS_CAPTION,
};

use crate::core::host::ModuleCtx;

/// `quiet` already includes `mic`.
#[derive(Serialize, Clone, Copy, PartialEq, Default, Debug)]
pub struct Presence {
    pub quiet: bool,
    pub mic: bool,
}

/// The window that just took the foreground: process id and executable file name (lowercase). Never its title.
#[derive(Clone, Debug)]
#[allow(dead_code)] // read by module subscribers of on_foreground (a later task)
pub struct Foreground {
    pub pid: u32,
    pub exe: String,
}

/// QUERY_USER_NOTIFICATION_STATE values that mean "do not disturb": BUSY (2), RUNNING_D3D_FULL_SCREEN (3),
/// PRESENTATION_MODE (4), QUIET_TIME (6).
pub fn quiet_of(state: i32) -> bool {
    matches!(state, 2 | 3 | 4 | 6)
}

/// `entries`: (app key, LastUsedTimeStop) of every app that ever used the mic; 0 = in use right now. The key is
/// an exe path with `#` for `\` (or a package family name). Our own exe is ignored: it is listed there too.
pub fn mic_in_use(entries: &[(String, u64)], own_exe: &str) -> bool {
    let own = own_exe.to_ascii_lowercase();
    entries.iter().any(|(key, stop)| {
        let name = key.rsplit(['#', '\\', '/']).next().unwrap_or(key).to_ascii_lowercase();
        *stop == 0 && name != own
    })
}

fn own_exe() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default()
}

/// A mic use that "started" this long ago and never stopped is taken as left over by a crash.
const STALE_USE_FT: u64 = 12 * 3600 * 10_000_000;

/// `start` and `now`: FILETIME ticks (100 ns since 1601).
fn stale_use(start: u64, now: u64) -> bool {
    now.saturating_sub(start) > STALE_USE_FT
}

fn filetime_now() -> u64 {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    (secs + 11_644_473_600) * 10_000_000
}

pub fn now() -> Presence {
    let state = unsafe { SHQueryUserNotificationState().map(|s| s.0).unwrap_or(5) };
    let mic = mic_in_use(&mic_entries(), &own_exe());
    Presence { quiet: quiet_of(state) || foreground_fills_monitor() || mic, mic }
}

/// The desktop, the taskbar and the shell's own overlays (Alt-Tab, Task View, Start): they cover the screen but
/// are not a full-screen app.
const SHELL_CLASSES: [&str; 7] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "XamlExplorerHostIslandWindow",
    "Windows.UI.Core.CoreWindow",
    "ForegroundStaging",
];

/// `win` covers all of `mon` (screen rects).
pub fn covers(win: &RECT, mon: &RECT) -> bool {
    win.left <= mon.left && win.top <= mon.top && win.right >= mon.right && win.bottom >= mon.bottom
}

/// The foreground window has no caption and covers its whole monitor: a borderless "full-screen window" game or
/// video. A maximized window keeps its caption (and stops at the taskbar), so it never counts.
fn foreground_fills_monitor() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() || GetWindowLongW(fg, GWL_STYLE) as u32 & WS_CAPTION.0 == WS_CAPTION.0 {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(fg, &mut class).max(0) as usize;
        if SHELL_CLASSES.contains(&String::from_utf16_lossy(&class[..n]).as_str()) {
            return false;
        }
        let mut r = RECT::default();
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetWindowRect(fg, &mut r).is_ok()
            && GetMonitorInfoW(MonitorFromWindow(fg, MONITOR_DEFAULTTONULL), &mut mi).as_bool()
            && covers(&r, &mi.rcMonitor)
    }
}

const MIC_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// (app key, LastUsedTimeStop) for the apps that have used the mic (LastUsedTimeStart != 0): packaged apps
/// under the key, classic ones under `NonPackaged`.
fn mic_entries() -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let ft = filetime_now();
    for parent in [MIC_KEY.to_string(), format!(r"{MIC_KEY}\NonPackaged")] {
        for name in subkeys(&parent) {
            if name == "NonPackaged" {
                continue;
            }
            let path = format!(r"{parent}\{name}");
            let (start, stop) = (qword(&path, "LastUsedTimeStart"), qword(&path, "LastUsedTimeStop"));
            if let (Some(start), Some(stop)) = (start, stop) {
                if start != 0 && !(stop == 0 && stale_use(start, ft)) {
                    out.push((name, stop));
                }
            }
        }
    }
    out
}

fn open(path: &str) -> Option<HKEY> {
    let mut key = HKEY::default();
    let p = wide(path);
    unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, windows::core::PCWSTR(p.as_ptr()), None, KEY_READ, &mut key)
            .is_ok()
            .then_some(key)
    }
}

fn subkeys(path: &str) -> Vec<String> {
    let Some(key) = open(path) else { return Vec::new() };
    let mut out = Vec::new();
    let mut buf = [0u16; 520];
    for i in 0.. {
        let mut len = buf.len() as u32;
        let r = unsafe { RegEnumKeyExW(key, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) };
        if r.is_err() {
            break;
        }
        out.push(String::from_utf16_lossy(&buf[..len as usize]));
    }
    unsafe {
        let _ = RegCloseKey(key);
    }
    out
}

fn qword(path: &str, value: &str) -> Option<u64> {
    let key = open(path)?;
    let name = wide(value);
    let mut data = [0u8; 8];
    let mut len = 8u32;
    let mut kind = REG_VALUE_TYPE::default();
    let ok = unsafe {
        RegQueryValueExW(key, windows::core::PCWSTR(name.as_ptr()), None, Some(&mut kind), Some(data.as_mut_ptr()), Some(&mut len))
            .is_ok()
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    (ok && len == 8).then(|| u64::from_le_bytes(data))
}

// ── Shared foreground hook ────────────────────────────────────────────────────

type Callback = fn(&AppHandle, &Foreground);
struct Sub {
    id: u64,
    cb: Callback,
}

static SUBS: Mutex<Vec<Sub>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
/// Serialises start/stop of the thread (never held by the hook callback).
static LIFECYCLE: Mutex<()> = Mutex::new(());
static THREAD: AtomicU32 = AtomicU32::new(0);
static HANDLE: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

fn subscribe(app: &AppHandle, cb: Callback) -> u64 {
    let _g = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    *APP.lock().unwrap() = Some(app.clone());
    let first = {
        let mut s = SUBS.lock().unwrap();
        s.push(Sub { id, cb });
        s.len() == 1
    };
    if first {
        *HANDLE.lock().unwrap() = Some(std::thread::spawn(hook_loop));
    }
    id
}

fn unsubscribe(id: u64) {
    let _g = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
    let empty = {
        let mut s = SUBS.lock().unwrap();
        let before = s.len();
        s.retain(|x| x.id != id);
        before != s.len() && s.is_empty()
    };
    if empty {
        quit_thread();
        *APP.lock().unwrap() = None;
    }
}

/// Calls `cb` on the hook thread at every foreground change, until the module stops. Must return fast and
/// must not stop modules or unsubscribe (the thread would wait on itself in `quit_thread`: deadlock).
/// All callers share one thread; it ends with the last of them.
pub fn on_foreground(ctx: &ModuleCtx, cb: fn(&AppHandle, &Foreground)) {
    let id = subscribe(&ctx.app, cb);
    ctx.on_stop(move || unsubscribe(id));
}

/// The window in front right now (exe name only), for a subscriber that needs a starting point.
pub fn foreground_now() -> Foreground {
    foreground_of(unsafe { GetForegroundWindow() })
}

/// Milliseconds since the last keyboard or mouse input (0 if the OS cannot say). One syscall, no thread.
pub fn user_idle_ms() -> u64 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        idle_since(unsafe { GetTickCount() }, info.dwTime)
    } else {
        0
    }
}

/// Both are 32-bit tick counts (wrap after ~49 days): the difference wraps too.
fn idle_since(tick_now: u32, last_input: u32) -> u64 {
    u64::from(tick_now.wrapping_sub(last_input))
}

/// Stops the thread and waits for it, so the hook is gone when this returns.
fn quit_thread() {
    let Some(h) = HANDLE.lock().unwrap().take() else { return };
    while !h.is_finished() {
        let id = THREAD.load(Ordering::SeqCst); // 0 until the thread has made its queue: retry
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let _ = h.join();
    THREAD.store(0, Ordering::SeqCst);
}

fn hook_loop() {
    unsafe {
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE); // creates the queue
        THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        // Out-of-context hooks are delivered from inside GetMessageW.
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_TIMER && msg.hwnd.is_invalid() {
                let _ = KillTimer(None, msg.wParam.0);
                let _ = RECHECK.compare_exchange(msg.wParam.0, 0, Ordering::SeqCst, Ordering::SeqCst);
                let _ = std::panic::catch_unwind(recheck);
            }
        }
        let t = RECHECK.swap(0, Ordering::SeqCst);
        if t != 0 {
            let _ = KillTimer(None, t);
        }
        if !hook.is_invalid() {
            let _ = UnhookWinEvent(hook);
        }
    }
}

/// A game often takes the foreground first and fills the screen a moment later.
const RECHECK_MS: u32 = 3000;
/// The pending one-shot recheck timer of the hook thread (0 = none).
static RECHECK: AtomicUsize = AtomicUsize::new(0);

/// Re-reads the island's answer, only while the island watches (LAST is set). Never takes WATCH: presence_watch
/// holds it while it waits for this thread to end.
fn recheck() {
    if LAST.lock().unwrap().is_none() {
        return;
    }
    if let Some(app) = APP.lock().unwrap().clone() {
        emit_changed(&app);
    }
}

unsafe extern "system" fn on_event(_h: HWINEVENTHOOK, event: u32, hwnd: HWND, _obj: i32, _child: i32, _thread: u32, _time: u32) {
    if event != EVENT_SYSTEM_FOREGROUND {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        let Some(app) = APP.lock().unwrap().clone() else { return };
        let cbs: Vec<Callback> = SUBS.lock().unwrap().iter().map(|s| s.cb).collect();
        let fg = foreground_of(hwnd);
        for cb in cbs {
            cb(&app, &fg);
        }
    });
    // Runs on the hook thread (inside GetMessageW), so the timer is this thread's own.
    let old = RECHECK.swap(SetTimer(None, 0, RECHECK_MS, None), Ordering::SeqCst);
    if old != 0 {
        let _ = KillTimer(None, old);
    }
}

fn foreground_of(hwnd: HWND) -> Foreground {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut exe = String::new();
        if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                exe = path.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase();
            }
            let _ = CloseHandle(h);
        }
        Foreground { pid, exe }
    }
}

// ── The core's own subscriber: the island ─────────────────────────────────────

static WATCH: Mutex<Option<u64>> = Mutex::new(None);
static LAST: Mutex<Option<Presence>> = Mutex::new(None);

fn emit_if_changed(app: &AppHandle, _fg: &Foreground) {
    emit_changed(app);
}

fn emit_changed(app: &AppHandle) {
    let p = now();
    let mut last = LAST.lock().unwrap();
    if *last != Some(p) {
        *last = Some(p);
        let _ = app.emit("presence", p);
    }
}

#[tauri::command]
pub fn presence_now() -> Presence {
    now()
}

/// `on`: subscribes the island (idempotent) and answers with the current state; later changes arrive as the
/// `presence {quiet, mic}` event. Off: the subscription goes, and the thread with it when nobody else listens.
#[tauri::command]
pub fn presence_watch(app: AppHandle, on: bool) -> Option<Presence> {
    let mut watch = WATCH.lock().unwrap();
    if on {
        if watch.is_none() {
            *watch = Some(subscribe(&app, emit_if_changed));
        }
        let p = now();
        *LAST.lock().unwrap() = Some(p);
        Some(p)
    } else {
        if let Some(id) = watch.take() {
            unsubscribe(id);
        }
        *LAST.lock().unwrap() = None;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_states() {
        for (s, q) in [(1, false), (2, true), (3, true), (4, true), (5, false), (6, true), (7, false), (0, false)] {
            assert_eq!(quiet_of(s), q, "state {s}");
        }
    }

    #[test]
    fn full_screen_window_covers_its_monitor() {
        let r = |left, top, right, bottom| RECT { left, top, right, bottom };
        let mon = r(1920, 0, 4480, 1440);
        assert!(covers(&r(1920, 0, 4480, 1440), &mon), "exactly the monitor");
        assert!(covers(&r(1912, -8, 4488, 1448), &mon), "overhanging borders");
        assert!(!covers(&r(1912, -8, 4488, 1400), &mon), "stops at the taskbar (maximized)");
        assert!(!covers(&r(0, 0, 1920, 1080), &mon), "another monitor");
    }

    #[test]
    fn idle_since_wraps_with_the_tick_counter() {
        assert_eq!(idle_since(5_000, 2_000), 3_000);
        assert_eq!(idle_since(1_000, u32::MAX - 999), 2_000); // counter wrapped between input and now
        assert_eq!(idle_since(7, 7), 0);
    }

    #[test]
    fn stale_uses_are_dropped() {
        let h = 3600 * 10_000_000u64;
        assert!(!stale_use(100 * h, 105 * h));
        assert!(stale_use(100 * h, 113 * h));
        assert!(!stale_use(100 * h, 90 * h)); // clock went back: not stale
    }

    #[test]
    fn mic_in_use_ignores_own_exe_and_finished_use() {
        let own = "coucou.exe";
        assert!(!mic_in_use(&[], own));
        // Finished (stop != 0): not in use.
        assert!(!mic_in_use(&[("C:#apps#chat.exe".into(), 133_000_000)], own));
        // Running (stop == 0).
        assert!(mic_in_use(&[("C:#apps#chat.exe".into(), 0)], own));
        // Ourselves, any case: ignored.
        assert!(!mic_in_use(&[("C:#Program Files#Coucou#Coucou.exe".into(), 0)], own));
        // Another app still counts next to our own.
        assert!(mic_in_use(&[("C:#x#coucou.exe".into(), 0), ("Vendor.App_8wekyb3d8bbwe".into(), 0)], own));
        // A different exe that merely ends the same way is not us.
        assert!(mic_in_use(&[("C:#x#notcoucou.exe".into(), 0)], own));
    }
}
