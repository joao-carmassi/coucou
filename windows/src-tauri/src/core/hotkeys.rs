// One GetMessageW thread for every module hotkey. Modules call `set` with their combo;
// the thread is rebuilt only when the set of combos changes, and does not exist when
// nothing is registered.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT, WM_USER,
};

/// Handlers run on the main thread (never the hotkey thread), so they may call `set`/`clear`.
pub type Handler = fn(&AppHandle);

#[derive(Clone)]
struct Entry {
    name: &'static str,
    label: &'static str,
    combo: String,
    on: Handler,
}

static ENTRIES: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
/// Combos the live thread was built for; empty = no thread.
static RUNNING: Mutex<Vec<(&'static str, String)>> = Mutex::new(Vec::new());
static THREAD: AtomicU32 = AtomicU32::new(0);
static HANDLE: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static ERROR: Mutex<String> = Mutex::new(String::new());

/// Registers `combo` for `name` ("" clears it). Cheap when nothing changed.
pub fn set(app: &AppHandle, name: &'static str, label: &'static str, combo: &str, on: Handler) {
    {
        let mut e = ENTRIES.lock().unwrap();
        e.retain(|x| x.name != name);
        if !combo.trim().is_empty() {
            e.push(Entry { name, label, combo: combo.trim().to_string(), on });
        }
    }
    rebuild(app);
}

pub fn clear(app: &AppHandle, name: &'static str) {
    ENTRIES.lock().unwrap().retain(|x| x.name != name);
    rebuild(app);
}

/// Why a combo could not be registered ("" = fine).
pub fn error() -> String {
    ERROR.lock().unwrap().clone()
}

/// Normalises "ctrl + alt+v" to "Ctrl+Alt+V"; falls back to `default` when it is not a hotkey.
/// An empty string stays empty (the hotkey is off).
pub fn clean(s: &str, default: &str) -> String {
    if s.trim().is_empty() {
        return String::new();
    }
    match parse_hotkey(s) {
        Some(_) => s
            .split('+')
            .map(|t| {
                let t = t.trim();
                let mut c = t.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join("+"),
        None => default.to_string(),
    }
}

fn rebuild(app: &AppHandle) {
    let entries = ENTRIES.lock().unwrap().clone();
    let want: Vec<_> = entries.iter().map(|e| (e.name, e.combo.clone())).collect();
    let mut running = RUNNING.lock().unwrap();
    if *running == want {
        return;
    }
    let had = !running.is_empty();
    quit_thread();
    *ERROR.lock().unwrap() = String::new();
    *running = want.clone();
    if want.is_empty() {
        if had {
            let _ = app.emit("voice-hotkey-error", String::new());
        }
        return;
    }
    let app = app.clone();
    *HANDLE.lock().unwrap() = Some(std::thread::spawn(move || hotkey_loop(app, entries)));
}

/// Stops the old thread and waits for it, so its UnregisterHotKey cannot run after the new RegisterHotKey.
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

fn hotkey_loop(app: AppHandle, entries: Vec<Entry>) {
    unsafe {
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE); // creates the queue
        THREAD.store(GetCurrentThreadId(), Ordering::SeqCst); // before RegisterHotKey, so quit_thread can always stop us
        let mut errors = Vec::new();
        let mut ids = Vec::new();
        for (i, e) in entries.iter().enumerate() {
            let id = i as i32 + 1;
            let Some((mods, vk)) = parse_hotkey(&e.combo) else {
                errors.push(format!("{}: atalho inválido ({})", e.label, e.combo));
                continue;
            };
            match RegisterHotKey(None, id, HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT, vk) {
                Ok(()) => ids.push(id),
                Err(err) => errors.push(format!("{}: não foi possível registrar {} ({err})", e.label, e.combo)),
            }
        }
        let error = errors.join(" · ");
        *ERROR.lock().unwrap() = error.clone();
        let _ = app.emit("voice-hotkey-error", error);
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_HOTKEY {
                if let Some(e) = entries.get((msg.wParam.0 as usize).wrapping_sub(1)) {
                    let (app, on) = (app.clone(), e.on);
                    let _ = app.clone().run_on_main_thread(move || on(&app));
                }
            }
        }
        for id in ids {
            let _ = UnregisterHotKey(None, id);
        }
    }
}

/// (modifiers: 1 Alt, 2 Ctrl, 4 Shift, 8 Win — the MOD_* values, virtual-key). Needs a modifier.
fn parse_hotkey(s: &str) -> Option<(u32, u32)> {
    let (mut mods, mut key) = (0u32, None);
    for tok in s.split('+').map(|t| t.trim().to_ascii_lowercase()) {
        match tok.as_str() {
            "alt" => mods |= 1,
            "ctrl" | "control" => mods |= 2,
            "shift" => mods |= 4,
            "win" | "super" | "meta" => mods |= 8,
            "space" => key = Some(0x20),
            t if t.len() == 1 && t.as_bytes()[0].is_ascii_alphanumeric() => key = Some(t.to_ascii_uppercase().as_bytes()[0] as u32),
            t if t.starts_with('f') && t[1..].parse::<u32>().is_ok_and(|n| (1..=24).contains(&n)) => {
                key = Some(0x70 + t[1..].parse::<u32>().unwrap() - 1)
            }
            _ => return None,
        }
    }
    if mods == 0 {
        return None;
    }
    key.map(|k| (mods, k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_combos() {
        assert_eq!(parse_hotkey("Ctrl+Alt+V"), Some((3, 'V' as u32)));
        assert_eq!(parse_hotkey("ctrl + shift + f5"), Some((6, 0x74)));
        assert_eq!(parse_hotkey("V"), None);
        assert_eq!(parse_hotkey("Ctrl+Alt"), None);
        assert_eq!(clean("ctrl + alt+v", "X"), "Ctrl+Alt+V");
        assert_eq!(clean("", "X"), "");
        assert_eq!(clean("nope", "X"), "X");
    }
}
