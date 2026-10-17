// Flow (F38): dictate into any app with the right Ctrl key. Hold it (250 ms or more) and speak; release to transcribe and paste.
// Double tap = hands-free, the next tap ends it. Esc cancels. Another key while it is held is a chord (Ctrl+C with the right hand): abort.
//
// The hook exists only while the module is on AND `voiceFlowEnabled` is true. The hook proc only reads the key code, the injected
// flag and the time; it never stores or logs a key, and it hands a small event to this thread's own message loop, so it returns
// within microseconds (a slow low-level hook is silently dropped by Windows). Right Ctrl is never swallowed; Esc is swallowed only
// while a Flow take is recording. The text is pasted only into the window that was in front when the take started.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::w;

use crate::core::host::ModuleCtx;

const HOLD_MS: u64 = 250;
const TAP_MS: u64 = 200;
const GAP_MS: u64 = 350;
/// One Flow take is cut at this many seconds of audio.
pub const MAX_SECS: usize = 120;
const CF_UNICODETEXT: u32 = 13;
const WM_EV: u32 = WM_APP + 1;

// ── State machine (pure) ─────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ev {
    RDown(u64),
    RUp(u64),
    /// Any other key going down (the key itself is never kept).
    OtherDown,
    Esc,
    /// The hold timer fired while Right Ctrl is still down.
    Tick(u64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cmd {
    Start { handsfree: bool },
    Stop,
    Cancel,
    /// A chord started while recording: throw the take away, say nothing.
    Abort,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Phase {
    #[default]
    Idle,
    Pressed(u64),
    Recording,
    HandsFree { armed: bool },
    /// A chord or a cancel: nothing happens until Right Ctrl comes up.
    Ignore,
}

#[derive(Default)]
pub struct Tap {
    phase: Phase,
    last_tap_up: Option<u64>,
    second: bool,
}

impl Tap {
    /// True while the hold timer must run.
    pub fn pressed(&self) -> bool {
        matches!(self.phase, Phase::Pressed(_))
    }

    pub fn step(&mut self, ev: Ev) -> Option<Cmd> {
        match (self.phase, ev) {
            (Phase::Idle, Ev::RDown(t)) => {
                self.second = self.last_tap_up.is_some_and(|u| t.saturating_sub(u) <= GAP_MS);
                self.phase = Phase::Pressed(t);
                None
            }
            (Phase::Idle, Ev::OtherDown | Ev::Esc) => {
                self.last_tap_up = None;
                None
            }
            (Phase::Pressed(t0), Ev::Tick(t)) if t.saturating_sub(t0) >= HOLD_MS => {
                self.phase = Phase::Recording;
                self.last_tap_up = None;
                Some(Cmd::Start { handsfree: false })
            }
            (Phase::Pressed(t0), Ev::RUp(t)) => {
                let tap = t.saturating_sub(t0) < TAP_MS;
                self.phase = Phase::Idle;
                if tap && self.second {
                    self.last_tap_up = None;
                    self.phase = Phase::HandsFree { armed: false };
                    Some(Cmd::Start { handsfree: true })
                } else {
                    self.last_tap_up = tap.then_some(t);
                    None
                }
            }
            (Phase::Pressed(_), Ev::OtherDown | Ev::Esc) => {
                self.phase = Phase::Ignore;
                self.last_tap_up = None;
                None
            }
            (Phase::Recording, Ev::RUp(_)) => {
                self.phase = Phase::Idle;
                Some(Cmd::Stop)
            }
            (Phase::Recording, Ev::OtherDown) => {
                self.phase = Phase::Ignore;
                Some(Cmd::Abort)
            }
            (Phase::Recording, Ev::Esc) => {
                self.phase = Phase::Ignore;
                Some(Cmd::Cancel)
            }
            (Phase::HandsFree { .. }, Ev::RDown(_)) => {
                self.phase = Phase::HandsFree { armed: true };
                None
            }
            (Phase::HandsFree { armed: true }, Ev::RUp(_)) => {
                self.phase = Phase::Idle;
                Some(Cmd::Stop)
            }
            (Phase::HandsFree { .. }, Ev::Esc) => {
                self.phase = Phase::Idle;
                Some(Cmd::Cancel)
            }
            (Phase::Ignore, Ev::RUp(_)) => {
                self.phase = Phase::Idle;
                None
            }
            _ => None,
        }
    }

    /// The take ended by itself (cap, error, module stop): forget a recording state.
    pub fn finished(&mut self) {
        if matches!(self.phase, Phase::Recording | Phase::HandsFree { .. }) {
            self.phase = Phase::Idle;
        }
    }
}

/// Paste only into the window that was in front when the take started.
pub fn same_target(target: isize, foreground: isize) -> bool {
    target != 0 && target == foreground
}

// ── Hook thread ──────────────────────────────────────────────────────────────

static THREAD: AtomicU32 = AtomicU32::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);
static WANT: AtomicBool = AtomicBool::new(false);
/// A Flow take is recording: the only time Esc is swallowed.
pub static ACTIVE: AtomicBool = AtomicBool::new(false);
static ESC_HELD: AtomicBool = AtomicBool::new(false);

/// Installs or removes the hook (module start / apply / stop). Removing waits for the thread to end.
pub fn set(ctx: &ModuleCtx, on: bool) {
    WANT.store(on, Ordering::SeqCst);
    if on {
        if !RUNNING.swap(true, Ordering::SeqCst) {
            let app = ctx.app.clone();
            ctx.spawn(move |stop| run(app, &stop));
        }
        return;
    }
    for _ in 0..100 {
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        let id = THREAD.load(Ordering::SeqCst); // 0 until the thread has made its queue: retry
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

unsafe extern "system" fn hook_proc(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        if k.flags.0 & 0x10 == 0 {
            // not injected (our own SendInput for the paste is ignored)
            let down = matches!(wp.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let kind = if k.vkCode == VK_RCONTROL.0 as u32 {
                if down { 1 } else { 2 }
            } else if k.vkCode == VK_ESCAPE.0 as u32 {
                if !down && ESC_HELD.swap(false, Ordering::SeqCst) {
                    return LRESULT(1); // the matching key-up of a swallowed Esc
                }
                if !down {
                    0
                } else if ACTIVE.load(Ordering::SeqCst) {
                    ESC_HELD.store(true, Ordering::SeqCst);
                    post(4, k.time);
                    return LRESULT(1);
                } else {
                    3
                }
            } else if down {
                3
            } else {
                0
            };
            if kind != 0 {
                post(kind, k.time);
            }
        }
    }
    CallNextHookEx(None, code, wp, lp)
}

unsafe fn post(kind: usize, time: u32) {
    let id = THREAD.load(Ordering::SeqCst);
    if id != 0 {
        let _ = PostThreadMessageW(id, WM_EV, WPARAM(kind), LPARAM(time as isize));
    }
}

fn run(app: AppHandle, stop: &AtomicBool) {
    unsafe {
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE); // creates the queue
        THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        if WANT.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
            if let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
                let mut tap = Tap::default();
                let mut timer = 0usize;
                while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                    let ev = match (msg.message, msg.wParam.0) {
                        (WM_EV, 1) => Some(Ev::RDown(msg.lParam.0 as u32 as u64)),
                        (WM_EV, 2) => Some(Ev::RUp(msg.lParam.0 as u32 as u64)),
                        (WM_EV, 3) => Some(Ev::OtherDown),
                        (WM_EV, 4) => Some(Ev::Esc),
                        (WM_TIMER, _) => Some(Ev::Tick(windows::Win32::System::SystemInformation::GetTickCount() as u64)),
                        _ => None,
                    };
                    let Some(ev) = ev else { continue };
                    if !ACTIVE.load(Ordering::SeqCst) {
                        tap.finished(); // the take ended on its own (cap, error)
                    }
                    let cmd = tap.step(ev);
                    // The hold timer runs only between Right Ctrl down and the 250 ms mark.
                    if tap.pressed() && timer == 0 {
                        timer = SetTimer(None, 0, (HOLD_MS + 20) as u32, None);
                    } else if !tap.pressed() && timer != 0 {
                        let _ = KillTimer(None, timer);
                        timer = 0;
                    }
                    match cmd {
                        Some(Cmd::Start { .. }) => {
                            let target = GetForegroundWindow().0 as isize;
                            if super::voice::start_flow(&app, target).is_err() {
                                tap.finished();
                            }
                        }
                        Some(Cmd::Stop) => super::voice::stop(),
                        Some(Cmd::Cancel | Cmd::Abort) => super::voice::cancel(),
                        None => {}
                    }
                }
                if timer != 0 {
                    let _ = KillTimer(None, timer);
                }
                let _ = UnhookWindowsHookEx(hook);
                if ACTIVE.swap(false, Ordering::SeqCst) {
                    super::voice::stop();
                }
            }
        }
        THREAD.store(0, Ordering::SeqCst);
        RUNNING.store(false, Ordering::SeqCst);
    }
}

// ── Paste ────────────────────────────────────────────────────────────────────

fn open_clipboard() -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// UTF-16 text now on the clipboard (clipboard must be open), or None.
unsafe fn read_text() -> Option<Vec<u16>> {
    let h = GetClipboardData(CF_UNICODETEXT).ok()?;
    let g = HGLOBAL(h.0);
    let p = GlobalLock(g) as *const u16;
    if p.is_null() {
        return None;
    }
    let max = GlobalSize(g) / 2;
    let mut v = Vec::new();
    for i in 0..max {
        let c = *p.add(i);
        if c == 0 {
            break;
        }
        v.push(c);
    }
    let _ = GlobalUnlock(g);
    Some(v)
}

/// Puts `bytes` on the open clipboard under `fmt`.
unsafe fn put(fmt: u32, bytes: &[u8]) -> Result<(), String> {
    let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(4)).map_err(|e| e.message())?;
    let p = GlobalLock(g) as *mut u8;
    if p.is_null() {
        return Err("memória indisponível".into());
    }
    std::ptr::write_bytes(p, 0, bytes.len().max(4));
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
    let _ = GlobalUnlock(g);
    SetClipboardData(fmt, Some(HANDLE(g.0))).map(|_| ()).map_err(|e| e.message())
}

fn utf16_bytes(units: &[u16]) -> Vec<u8> {
    units.iter().chain(std::iter::once(&0)).flat_map(|u| u.to_le_bytes()).collect()
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// Pastes `text` into `target` (the window in front when the take started) with Ctrl+V. The text goes on the clipboard with the
/// "exclude from history and cloud" format, and the previous text is put back ~150 ms later (only if nothing else wrote to the
/// clipboard meanwhile). `Err("moved")` = another window is in front now: nothing was touched.
// shortcut: only CF_UNICODETEXT is saved and restored, so a copied image or file list is lost; snapshot every format if users complain.
pub fn paste(text: &str, target: isize) -> Result<(), String> {
    unsafe {
        if !same_target(target, GetForegroundWindow().0 as isize) {
            return Err("moved".into());
        }
        if !open_clipboard() {
            return Err("A área de transferência está ocupada.".into());
        }
        let saved = read_text();
        let _ = EmptyClipboard();
        let units: Vec<u16> = text.encode_utf16().collect();
        let set = put(CF_UNICODETEXT, &utf16_bytes(&units));
        let fmt = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
        if fmt != 0 {
            let _ = put(fmt, &[0, 0, 0, 0]);
        }
        let _ = CloseClipboard();
        set?;
        let seq = GetClipboardSequenceNumber();
        let inputs = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(Duration::from_millis(150));
        if GetClipboardSequenceNumber() == seq && open_clipboard() {
            let _ = EmptyClipboard();
            if let Some(old) = saved.filter(|v| !v.is_empty()) {
                let _ = put(CF_UNICODETEXT, &utf16_bytes(&old));
            }
            let _ = CloseClipboard();
        }
        if sent as usize != inputs.len() {
            return Err("O Windows recusou a colagem.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_all(evs: &[Ev]) -> Vec<Option<Cmd>> {
        let mut t = Tap::default();
        evs.iter().map(|e| t.step(*e)).collect()
    }

    #[test]
    fn hold_records_and_release_stops() {
        let r = run_all(&[Ev::RDown(1000), Ev::Tick(1270), Ev::RUp(2500)]);
        assert_eq!(r, [None, Some(Cmd::Start { handsfree: false }), Some(Cmd::Stop)]);
    }

    #[test]
    fn hold_needs_250ms() {
        assert_eq!(run_all(&[Ev::RDown(1000), Ev::Tick(1249)])[1], None);
        assert_eq!(run_all(&[Ev::RDown(1000), Ev::Tick(1250)])[1], Some(Cmd::Start { handsfree: false }));
    }

    #[test]
    fn short_tap_does_nothing() {
        assert_eq!(run_all(&[Ev::RDown(1000), Ev::RUp(1150)]), [None, None]);
        // a 200 ms press is no longer a tap, so the next short tap is a first tap again
        assert_eq!(run_all(&[Ev::RDown(1000), Ev::RUp(1200), Ev::RDown(1300), Ev::RUp(1400)])[3], None);
    }

    #[test]
    fn double_tap_is_hands_free_and_next_tap_ends_it() {
        let r = run_all(&[Ev::RDown(1000), Ev::RUp(1100), Ev::RDown(1449), Ev::RUp(1550), Ev::RDown(5000), Ev::RUp(5080)]);
        assert_eq!(r, [None, None, None, Some(Cmd::Start { handsfree: true }), None, Some(Cmd::Stop)]);
    }

    #[test]
    fn double_tap_gap_is_350ms_after_the_first_release() {
        // first release at 1100: a second press at 1450 (350) counts, at 1451 (351) does not
        assert_eq!(run_all(&[Ev::RDown(1000), Ev::RUp(1100), Ev::RDown(1450), Ev::RUp(1550)])[3], Some(Cmd::Start { handsfree: true }));
        assert_eq!(run_all(&[Ev::RDown(1000), Ev::RUp(1100), Ev::RDown(1451), Ev::RUp(1550)])[3], None);
        // 349 ms and 351 ms around the limit, measured from the release
        assert_eq!(run_all(&[Ev::RDown(0), Ev::RUp(100), Ev::RDown(449), Ev::RUp(500)])[3], Some(Cmd::Start { handsfree: true }));
        assert_eq!(run_all(&[Ev::RDown(0), Ev::RUp(100), Ev::RDown(451), Ev::RUp(500)])[3], None);
    }

    #[test]
    fn a_long_second_press_is_a_hold() {
        let r = run_all(&[Ev::RDown(0), Ev::RUp(100), Ev::RDown(200), Ev::Tick(470), Ev::RUp(900)]);
        assert_eq!(r[3], Some(Cmd::Start { handsfree: false }));
        assert_eq!(r[4], Some(Cmd::Stop));
    }

    #[test]
    fn chord_aborts_silently() {
        // before the timer: no start at all
        assert_eq!(run_all(&[Ev::RDown(0), Ev::OtherDown, Ev::Tick(300), Ev::RUp(400)]), [None, None, None, None]);
        // while recording: abort, and the release afterwards does nothing
        let r = run_all(&[Ev::RDown(0), Ev::Tick(270), Ev::OtherDown, Ev::RUp(900)]);
        assert_eq!(r, [None, Some(Cmd::Start { handsfree: false }), Some(Cmd::Abort), None]);
    }

    #[test]
    fn esc_cancels_a_take_and_is_ignored_when_idle() {
        let r = run_all(&[Ev::RDown(0), Ev::Tick(270), Ev::Esc, Ev::RUp(900)]);
        assert_eq!(r, [None, Some(Cmd::Start { handsfree: false }), Some(Cmd::Cancel), None]);
        assert_eq!(run_all(&[Ev::Esc]), [None]);
        let h = run_all(&[Ev::RDown(0), Ev::RUp(50), Ev::RDown(100), Ev::RUp(150), Ev::Esc]);
        assert_eq!(h[4], Some(Cmd::Cancel));
    }

    #[test]
    fn typing_between_taps_breaks_the_double_tap() {
        let r = run_all(&[Ev::RDown(0), Ev::RUp(50), Ev::OtherDown, Ev::RDown(100), Ev::RUp(150)]);
        assert_eq!(r[4], None);
    }

    #[test]
    fn key_repeat_of_right_ctrl_is_ignored() {
        let r = run_all(&[Ev::RDown(0), Ev::RDown(30), Ev::RDown(60), Ev::Tick(270), Ev::RDown(300), Ev::RUp(800)]);
        assert_eq!(r[3], Some(Cmd::Start { handsfree: false }));
        assert_eq!(r[5], Some(Cmd::Stop));
    }

    #[test]
    fn paste_only_into_the_original_window() {
        assert!(same_target(0x1234, 0x1234));
        assert!(!same_target(0x1234, 0x5678));
        assert!(!same_target(0, 0), "no window recorded: never paste");
    }
}
