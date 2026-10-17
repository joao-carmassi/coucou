// Debounced directory watcher on ReadDirectoryChangesW. One blocking thread (via the caller's
// Spawner) per watch, parked on kernel events: zero cost while nothing changes, no polling.

use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, ERROR_NOTIFY_ENUM_DIR, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use super::host::Spawner;

pub const DEFAULT_DEBOUNCE_MS: u64 = 2000;

/// Owned event handle (HANDLE is !Send, the kernel object is fine across threads).
struct Ev(HANDLE);
unsafe impl Send for Ev {}
unsafe impl Sync for Ev {}
impl Drop for Ev {
    fn drop(&mut self) {
        unsafe { let _ = CloseHandle(self.0); }
    }
}
fn event() -> Option<Ev> {
    unsafe { CreateEventW(None, true, false, PCWSTR::null()).ok().map(Ev) }
}

/// Dropping it stops the watch. The module must drop it from its `stop` so a host stop ends the thread.
pub struct Guard(Arc<Ev>);
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe { let _ = SetEvent(self.0 .0); }
    }
}

/// `on_change` runs on the watcher thread once per quiet window, with the unique changed paths.
/// A failed setup (bad dir) yields an inert Guard.
pub fn watch(
    dir: &Path,
    recursive: bool,
    spawner: Spawner,
    debounce_ms: u64,
    on_change: impl Fn(Vec<PathBuf>) + Send + Sync + 'static,
) -> Guard {
    let Some(stop_ev) = event().map(Arc::new) else {
        return Guard(Arc::new(Ev(HANDLE::default()))); // inert: CloseHandle on null just fails
    };
    let guard = Guard(stop_ev.clone());
    let dir = dir.to_path_buf();
    spawner.spawn(move |host_stop| run(&dir, recursive, debounce_ms, &stop_ev, &host_stop, &on_change));
    guard
}

fn run(
    dir: &Path,
    recursive: bool,
    debounce_ms: u64,
    stop_ev: &Ev,
    host_stop: &std::sync::atomic::AtomicBool,
    on_change: &dyn Fn(Vec<PathBuf>),
) {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let h = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_LIST_DIRECTORY.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
            None,
        )
    };
    let Ok(h) = h else { return };
    let Some(io_ev) = event() else { unsafe { let _ = CloseHandle(h); } return };
    // Owns the handle, buffer and OVERLAPPED: any exit (break, panic) cancels and waits before they are freed.
    let mut rd = Reader { h, ov: Box::new(OVERLAPPED { hEvent: io_ev.0, ..Default::default() }), buf: vec![0u32; 16 * 1024], armed: false };
    let mut pending: Vec<PathBuf> = Vec::new();
    let mut deadline: Option<Instant> = None;
    let mut first: Option<Instant> = None; // cap: continuous writes still fire after 4x debounce
    let win = Duration::from_millis(debounce_ms);
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE;

    'outer: loop {
        unsafe {
            let _ = windows::Win32::System::Threading::ResetEvent(io_ev.0);
            *rd.ov = OVERLAPPED { hEvent: io_ev.0, ..Default::default() };
            if ReadDirectoryChangesW(rd.h, rd.buf.as_mut_ptr().cast(), (rd.buf.len() * 4) as u32, recursive, filter, None, Some(&mut *rd.ov), None).is_err() {
                break;
            }
        }
        rd.armed = true;
        loop {
            let timeout = match deadline {
                // idle: block forever; pending: only until the quiet window ends
                None => u32::MAX,
                Some(d) => d.saturating_duration_since(Instant::now()).as_millis() as u32,
            };
            let r = unsafe { WaitForMultipleObjects(&[io_ev.0, stop_ev.0], false, timeout) };
            if host_stop.load(Ordering::SeqCst) || r.0 == WAIT_OBJECT_0.0 + 1 {
                break 'outer;
            }
            if r.0 == WAIT_OBJECT_0.0 {
                let mut n = 0u32;
                let res = unsafe { GetOverlappedResult(rd.h, &*rd.ov, &mut n, false) };
                rd.armed = false;
                match res {
                    Ok(()) => collect(&rd.buf, n as usize, dir, &mut pending),
                    Err(e) if e.code() == ERROR_NOTIFY_ENUM_DIR.to_hresult() => pending.push(dir.to_path_buf()),
                    Err(_) => break 'outer,
                }
                let now = Instant::now();
                let f = *first.get_or_insert(now);
                deadline = Some((now + win).min(f + win * 4));
                continue 'outer; // re-arm the read; the window restarts on each burst
            }
            // timeout: quiet window (or cap) elapsed
            if !pending.is_empty() {
                pending.sort();
                pending.dedup();
                let batch = std::mem::take(&mut pending);
                // a panicking callback must not leave the watch half torn down
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_change(batch)));
            }
            deadline = None;
            first = None;
        }
    }
}

struct Reader {
    h: HANDLE,
    ov: Box<OVERLAPPED>,
    buf: Vec<u32>, // 64 KiB, DWORD-aligned
    armed: bool,
}
impl Drop for Reader {
    fn drop(&mut self) {
        unsafe {
            if self.armed {
                let _ = CancelIoEx(self.h, Some(&*self.ov));
                let mut n = 0u32;
                let _ = GetOverlappedResult(self.h, &*self.ov, &mut n, true); // kernel is done with buf/ov after this
            }
            let _ = CloseHandle(self.h);
        }
    }
}

fn collect(buf: &[u32], bytes: usize, dir: &Path, out: &mut Vec<PathBuf>) {
    if bytes == 0 {
        out.push(dir.to_path_buf()); // buffer overflow: something changed, we do not know what
        return;
    }
    let raw = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), bytes) };
    let u32_at = |o: usize| u32::from_le_bytes(raw[o..o + 4].try_into().unwrap()) as usize;
    let mut off = 0;
    while off + 12 <= raw.len() {
        let next = u32_at(off);
        let len = u32_at(off + 8);
        let Some(name) = raw.get(off + 12..off + 12 + len) else { break };
        let w: Vec<u16> = name.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        out.push(dir.join(String::from_utf16_lossy(&w)));
        if next == 0 {
            break;
        }
        off += next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::host::{Spawner, TaskSet};
    use std::sync::Mutex;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("coucou-fswatch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn one_write_one_callback_after_debounce() {
        let d = tmp("one");
        let tasks = Arc::new(TaskSet::default());
        let got = Arc::new(Mutex::new(Vec::<Vec<PathBuf>>::new()));
        let g2 = got.clone();
        let guard = watch(&d, false, Spawner::for_test(&tasks), 200, move |p| g2.lock().unwrap().push(p));
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(d.join("a.txt"), "1").unwrap();
        std::fs::write(d.join("a.txt"), "22").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(got.lock().unwrap().is_empty(), "fired before the debounce window");
        std::thread::sleep(Duration::from_millis(600));
        let v = got.lock().unwrap();
        assert_eq!(v.len(), 1, "{v:?}");
        assert_eq!(v[0], vec![d.join("a.txt")]);
        drop(v);
        drop(guard);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn callback_panic_does_not_kill_the_watch() {
        let d = tmp("panic");
        let tasks = Arc::new(TaskSet::default());
        let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n2 = n.clone();
        let guard = watch(&d, false, Spawner::for_test(&tasks), 100, move |_| {
            if n2.fetch_add(1, Ordering::SeqCst) == 0 { panic!("boom") }
        });
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(d.join("a"), "1").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(d.join("b"), "1").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(n.load(Ordering::SeqCst), 2);
        assert_eq!(tasks.live(), 1);
        drop(guard);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn guard_drop_stops_thread() {
        let d = tmp("drop");
        let tasks = Arc::new(TaskSet::default());
        let guard = watch(&d, true, Spawner::for_test(&tasks), 100, |_| {});
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(tasks.live(), 1);
        drop(guard);
        let t0 = Instant::now();
        while tasks.live() > 0 && t0.elapsed() < Duration::from_millis(250) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(tasks.live(), 0, "thread still alive after Guard drop");
        let _ = std::fs::remove_dir_all(&d);
    }
}
