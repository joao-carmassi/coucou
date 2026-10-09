// Bringing an existing terminal window to the front.
//
// The relay reports the processes above it (`terminal_pids`, nearest first).
// One of them owns the window the session runs in: WindowsTerminal.exe for a WSL
// or PowerShell tab, Code.exe for VS Code's integrated terminal, a conhost for a
// bare console. "Open terminal" brings that window forward; without one it opens
// a new terminal in the session folder.

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Console::{
    AttachConsole, FreeConsole, GetConsoleWindow, GetStdHandle, SetConsoleCtrlHandler, SetStdHandle,
    STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetForegroundWindow, GetWindow, GetWindowLongW,
    GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SetForegroundWindow, ShowWindow, GA_ROOTOWNER, GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WS_EX_TOOLWINDOW,
};

struct Candidate {
    hwnd: HWND,
    pid: u32,
}

/// Every window a user would call "a window", front to back (EnumWindows walks
/// the z-order), so the first match is the one they used last.
fn app_windows() -> Vec<Candidate> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<Candidate>);
        let visible = IsWindowVisible(hwnd).as_bool();
        let owned = GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false);
        let tool = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0;
        if visible && !owned && !tool && GetWindowTextLengthW(hwnd) > 0 {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            out.push(Candidate { hwnd, pid });
        }
        BOOL(1)
    }
    let mut out: Vec<Candidate> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

/// The session's own window, if one of its ancestors has one. Never another
/// terminal: that may be a different session's. Brings it forward and says whether there was one: a window Windows
/// would not let us raise still flashes in the taskbar, and opening a second
/// terminal on top of that would only add to the confusion.
pub fn existing_terminal(pids: &[u32]) -> bool {
    // The console a process is attached to names its window exactly. Matching by
    // process id cannot: Windows Terminal hosts every window in one process, and
    // consoles Coucou launches get handed to it outside the process chain.
    let hwnd = pids.iter().find_map(|p| console_window(*p)).or_else(|| {
        let windows = app_windows();
        let me = std::process::id();
        pids.iter()
            .filter(|p| **p != me)
            .find_map(|pid| windows.iter().find(|w| w.pid == *pid))
            .map(|w| w.hwnd)
    });
    let Some(hwnd) = hwnd else { return false };
    if !bring_forward(hwnd) {
        crate::log::line("could not bring the terminal window forward".to_string());
    }
    true
}

static CONSOLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The top-level window of the console `pid` is attached to, found by briefly
/// attaching to it (a process has one console, so this is serialized). None on
/// any failure, e.g. an elevated process.
fn console_window(pid: u32) -> Option<HWND> {
    let _guard = CONSOLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        // Already have our own console (debug build): cannot attach to another.
        if !GetConsoleWindow().is_invalid() {
            return None;
        }
        // Ctrl+C typed in the attached console must not kill us.
        let _ = SetConsoleCtrlHandler(None, true);
        // Attaching rewrites the standard handles and FreeConsole leaves them
        // dangling, which makes the next spawn fail with "invalid handle" (os error 6).
        let std = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map(|k| (k, GetStdHandle(k).ok()));
        let found = if AttachConsole(pid).is_ok() {
            let h = GetConsoleWindow();
            let _ = FreeConsole();
            for (k, old) in std {
                let _ = SetStdHandle(k, old.unwrap_or_default());
            }
            Some(h).filter(|h| !h.is_invalid())
        } else {
            None
        };
        let _ = SetConsoleCtrlHandler(None, false);
        let root = GetAncestor(found?, GA_ROOTOWNER);
        (!root.is_invalid() && IsWindowVisible(root).as_bool()).then_some(root)
    }
}

fn bring_forward(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() && GetForegroundWindow() == hwnd {
            return true;
        }
        // The island never takes focus, so Windows may refuse to let us hand it
        // to someone else. A synthetic Alt press counts as "the user just typed",
        // which lifts the foreground lock for the next call.
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VK_MENU, dwFlags: flags, ..Default::default() },
            },
        };
        let inputs = [key(Default::default()), key(KEYEVENTF_KEYUP)];
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        let _ = SetForegroundWindow(hwnd);
        GetForegroundWindow() == hwnd
    }
}
