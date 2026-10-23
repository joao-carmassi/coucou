// Bringing an existing terminal window to the front.
//
// The relay reports the processes above it (`terminal_pids`, nearest first).
// One of them owns the window the session runs in: WindowsTerminal.exe for a WSL
// or PowerShell tab, Code.exe for VS Code's integrated terminal, a conhost for a
// bare console. "Open terminal" brings that window forward; without one it opens
// a new terminal in the session folder.

use windows::core::{Interface, BOOL};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomation6, IUIAutomationSelectionItemPattern, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Console::{
    AttachConsole, FreeConsole, GetConsoleTitleW, GetConsoleWindow, GetStdHandle, SetConsoleCtrlHandler, SetStdHandle,
    STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW,
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
pub fn existing_terminal(pids: &[u32], title: Option<&str>, cwd: Option<&str>) -> bool {
    // The console a process is attached to names its window exactly. Matching by
    // process id cannot: Windows Terminal hosts every window in one process, and
    // consoles Coucou launches get handed to it outside the process chain.
    let found = pids.iter().find_map(|p| console_window(*p)).or_else(|| {
        let windows = app_windows();
        let me = std::process::id();
        pids.iter()
            .filter(|p| **p != me)
            .find_map(|pid| windows.iter().find(|w| w.pid == *pid))
            .map(|w| (w.hwnd, String::new()))
    });
    let Some((hwnd, console_title)) = found else { return false };
    if !bring_forward(hwnd) {
        crate::core::log::line("could not bring the terminal window forward".to_string());
    }
    // Windows Terminal hosts many sessions in one window: best effort, pick this session's tab.
    // The console's own title is what the tab is called, so it is the surest hint.
    let mut hints = tab_hints(title, cwd);
    if !console_title.trim().is_empty() {
        hints.insert(0, console_title.trim().to_string());
    }
    if !hints.is_empty() && is_terminal_window(hwnd) {
        select_wt_tab(hwnd, hints);
    }
    true
}

static CONSOLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The top-level window of the console `pid` is attached to, and the console's
/// title (a Windows Terminal tab's name), found by briefly attaching to it (a
/// process has one console, so this is serialized). None on any failure, e.g. an
/// elevated process.
fn console_window(pid: u32) -> Option<(HWND, String)> {
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
            let mut title = [0u16; 512];
            let n = (GetConsoleTitleW(&mut title) as usize).min(title.len());
            let _ = FreeConsole();
            for (k, old) in std {
                let _ = SetStdHandle(k, old.unwrap_or_default());
            }
            Some((h, String::from_utf16_lossy(&title[..n]))).filter(|(h, _)| !h.is_invalid())
        } else {
            None
        };
        let _ = SetConsoleCtrlHandler(None, false);
        let (h, title) = found?;
        let root = GetAncestor(h, GA_ROOTOWNER);
        (!root.is_invalid() && IsWindowVisible(root).as_bool()).then_some((root, title))
    }
}

/// Every running process named `exe` (case-insensitive), e.g. the herdr clients.
pub fn pids_named(exe: &str) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(exe) {
                out.push(entry.th32ProcessID);
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
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

/// What a tab of this session may be called: its title first, then its folder's name.
fn tab_hints(title: Option<&str>, cwd: Option<&str>) -> Vec<String> {
    let folder = cwd.and_then(|c| c.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next());
    [title, folder].into_iter().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// The first tab whose name holds a hint, hints in order of trust, case-insensitive. No hints, no pick.
fn pick_tab(names: &[String], hints: &[String]) -> Option<usize> {
    let lower: Vec<String> = names.iter().map(|n| n.trim().to_lowercase()).collect();
    let hints: Vec<String> = hints.iter().map(|h| h.trim().to_lowercase()).filter(|h| !h.is_empty()).collect();
    // Hints in order of trust; for each, an exact name beats a partial one, and short hints (1-2 chars) only match exactly.
    hints.iter().find_map(|h| {
        lower.iter().position(|n| n == h).or_else(|| {
            (h.chars().count() >= 3).then(|| lower.iter().position(|n| n.contains(h.as_str()))).flatten()
        })
    })
}

fn is_terminal_window(hwnd: HWND) -> bool {
    let mut class = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, &mut class) };
    String::from_utf16_lossy(&class[..n.max(0) as usize]) == "CASCADIA_HOSTING_WINDOW_CLASS"
}

/// Budget for each UIA call; past it the call fails and the plain window focus stands.
const UIA_BUDGET_MS: u32 = 300;
/// Budget for the whole search; past it the plain window focus stands.
const UIA_TOTAL: std::time::Duration = std::time::Duration::from_millis(300);

/// Selects the Windows Terminal tab that matches a hint. UI Automation, read plus Select only
/// (never keystrokes), on the click's own thread. False on any failure, e.g. an elevated terminal.
fn select_wt_tab(hwnd: HWND, hints: Vec<String>) -> bool {
    unsafe { select_tab(hwnd, &hints) }.is_some()
}

unsafe fn select_tab(hwnd: HWND, hints: &[String]) -> Option<()> {
    // The thread may already be COM-initialised in another mode: that is fine, UIA works in either.
    let inited = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
    let started = std::time::Instant::now();
    let done = (|| {
        let ui: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        if let Ok(ui6) = ui.cast::<IUIAutomation6>() {
            let _ = ui6.SetConnectionTimeout(UIA_BUDGET_MS);
            let _ = ui6.SetTransactionTimeout(UIA_BUDGET_MS);
        }
        let cond = ui.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0)).ok()?;
        // One round trip: the names come cached with the tabs, not one cross-process call each.
        let cache = ui.CreateCacheRequest().ok()?;
        cache.AddProperty(UIA_NamePropertyId).ok()?;
        let tabs = ui.ElementFromHandle(hwnd).ok()?.FindAllBuildCache(TreeScope_Descendants, &cond, &cache).ok()?;
        let mut names = Vec::new();
        for i in 0..tabs.Length().ok()? {
            // Overall guard: the per-call timeouts add up over many tabs.
            if started.elapsed() > UIA_TOTAL {
                return None;
            }
            names.push(tabs.GetElement(i).and_then(|e| e.CachedName()).map(|n| n.to_string()).unwrap_or_default());
        }
        let tab = tabs.GetElement(pick_tab(&names, hints)? as i32).ok()?;
        let pattern: IUIAutomationSelectionItemPattern = tab.GetCurrentPatternAs(UIA_SelectionItemPatternId).ok()?;
        if started.elapsed() > UIA_TOTAL {
            return None;
        }
        pattern.Select().ok()
    })();
    if inited {
        CoUninitialize();
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn title_beats_folder() {
        let names = v(&["pwsh", "coucou", "Refatorar painel"]);
        assert_eq!(pick_tab(&names, &v(&["refatorar", "coucou"])), Some(2));
        assert_eq!(pick_tab(&names, &v(&["nada", "COUCOU"])), Some(1));
    }

    #[test]
    fn no_hints_no_pick() {
        assert_eq!(pick_tab(&v(&["a"]), &[]), None);
        assert_eq!(pick_tab(&v(&["a"]), &v(&["", "  "])), None);
        assert_eq!(pick_tab(&v(&["a"]), &v(&["z"])), None);
    }

    #[test]
    fn exact_beats_partial_and_short_hints_only_exact() {
        let names = v(&["coucou-old", "Coucou"]);
        assert_eq!(pick_tab(&names, &v(&["coucou"])), Some(1));
        assert_eq!(pick_tab(&v(&["abc", "a"]), &v(&["a"])), Some(1));
        assert_eq!(pick_tab(&v(&["abc"]), &v(&["ab"])), None);
    }

    #[test]
    fn hints_from_title_and_cwd() {
        assert_eq!(tab_hints(Some(" T "), Some("C:\\x\\proj\\")), v(&["T", "proj"]));
        assert_eq!(tab_hints(None, None), Vec::<String>::new());
    }
}
