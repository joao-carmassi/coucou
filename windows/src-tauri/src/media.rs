// Mídia: what Windows saved (Pictures\Screenshots, Videos\Captures) and what
// came onto the island (dropped files, Coucou's own captures), newest first.
// The list is a JSON file of paths under local_dir(): files are never copied,
// and taking one off the list never touches the file on disk.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::settings;

const MAX_ITEMS: usize = 300;
/// A file already in a watched folder when the app starts is listed only if recent.
#[cfg(windows)]
const SCAN_MS: u64 = 30 * 24 * 60 * 60 * 1000;
#[cfg(windows)]
const MEDIA_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "webp", "mp4", "mkv", "mov", "webm", "avi"];

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    path: String,
    /// "screenshot", "video" or "file" (dropped or captured by Coucou).
    kind: String,
    /// Unix ms: the file's own time for what Windows saved, the drop's for the rest.
    ts: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    items: Vec<Entry>,
    /// Taken off the list by the user: the watchers must not bring them back.
    removed: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub ts: u64,
    pub size: u64,
}

fn store_path() -> std::path::PathBuf {
    settings::local_dir().join("media.json")
}

fn load() -> Store {
    std::fs::read(store_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(store: &Store) {
    let _ = crate::platform::ensure_private_dir(&settings::local_dir());
    if let Ok(json) = serde_json::to_vec(store) {
        let _ = std::fs::write(store_path(), json);
    }
}

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(windows)]
fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or_else(now_ms, |d| d.as_millis() as u64)
}

#[cfg(windows)]
fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MEDIA_EXT.iter().any(|m| m.eq_ignore_ascii_case(e)))
}

/// Puts a path on the list. A watcher (`user` false) never brings back what the
/// user removed; a drop (`user` true) does. False when it was already there.
fn add(path: &Path, kind: &str, ts: u64, user: bool) -> bool {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = path.to_string_lossy().to_string();
    let mut store = load();
    if store.items.iter().any(|e| same(&e.path, &text)) {
        return false;
    }
    if store.removed.iter().any(|r| same(r, &text)) {
        if !user {
            return false;
        }
        store.removed.retain(|r| !same(r, &text));
    }
    store.items.push(Entry { path: text, kind: kind.into(), ts });
    store.items.sort_by(|a, b| b.ts.cmp(&a.ts));
    store.items.truncate(MAX_ITEMS);
    save(&store);
    true
}

/// A file that came onto the island (ingest) or that Coucou captured.
pub fn note_drop(path: &Path) {
    add(path, "file", now_ms(), true);
}

/// The list, newest first. Entries whose file is gone (the inbox is swept after
/// a week, originals get deleted) are pruned here.
pub fn list() -> Vec<MediaItem> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load();
    let (before, removed_before) = (store.items.len(), store.removed.len());
    store.items.retain(|e| Path::new(&e.path).is_file());
    store.removed.retain(|p| Path::new(p).is_file());
    if store.items.len() != before || store.removed.len() != removed_before {
        save(&store);
    }
    store
        .items
        .into_iter()
        .map(|e| MediaItem {
            name: Path::new(&e.path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            size: std::fs::metadata(&e.path).map(|m| m.len()).unwrap_or(0),
            path: e.path,
            kind: e.kind,
            ts: e.ts,
        })
        .collect()
}

/// Off the list only; the file stays where it is.
pub fn remove(path: &str) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load();
    store.items.retain(|e| !same(&e.path, path));
    if !store.removed.iter().any(|r| same(r, path)) {
        store.removed.push(path.to_string());
    }
    save(&store);
}

/// The commands act only on what the list holds, never on a path the page makes up.
fn listed(path: &str) -> Result<(), String> {
    if load().items.iter().any(|e| same(&e.path, path)) {
        Ok(())
    } else {
        Err("Este arquivo não está na lista.".into())
    }
}

pub fn thumb(path: &str, px: u32) -> Result<Vec<u8>, String> {
    listed(path)?;
    sys::thumb(path, px)
}

pub fn open(path: &str) -> Result<(), String> {
    listed(path)?;
    sys::open(path)
}

pub fn open_with(path: &str) -> Result<(), String> {
    listed(path)?;
    sys::open_with(path)
}

pub fn reveal(path: &str) -> Result<(), String> {
    listed(path)?;
    sys::reveal(path)
}

pub use sys::start;

#[cfg(windows)]
mod sys {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, SIZE};
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        FOLDERID_Screenshots, FOLDERID_Videos, IShellItemImageFactory, SHCreateItemFromParsingName, SHGetKnownFolderPath,
        SHOpenWithDialog, ShellExecuteW, KF_FLAG_DEFAULT, OAIF_EXEC, OAIF_HIDE_REGISTRATION, OPENASINFO, SIIGBF,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::{add, is_media, mtime_ms, now_ms, SCAN_MS};

    /// Shell objects want COM up on the thread: the work gets one of its own.
    fn sta<T: Send>(work: impl FnOnce() -> T + Send) -> T {
        std::thread::scope(|s| {
            s.spawn(|| unsafe {
                let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let out = work();
                if init.is_ok() {
                    CoUninitialize();
                }
                out
            })
            .join()
            .expect("shell worker")
        })
    }

    fn known(id: &windows::core::GUID) -> Option<PathBuf> {
        unsafe {
            let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let text = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            text.map(PathBuf::from)
        }
    }

    /// Both folders, skipping one that is not there (no Captures until the Game Bar records).
    fn folders() -> Vec<(PathBuf, &'static str)> {
        let mut v = Vec::new();
        if let Some(p) = known(&FOLDERID_Screenshots) {
            v.push((p, "screenshot"));
        }
        if let Some(p) = known(&FOLDERID_Videos) {
            v.push((p.join("Captures"), "video"));
        }
        v.retain(|(p, _)| p.is_dir());
        v
    }

    pub fn start(app: AppHandle) {
        for (dir, kind) in folders() {
            let app = app.clone();
            std::thread::spawn(move || watch(app, dir, kind));
        }
    }

    /// Opens without sharing: fails while whoever is writing it still holds it.
    fn free(path: &Path) -> bool {
        std::fs::OpenOptions::new().read(true).share_mode(0).open(path).is_ok()
    }

    /// ADDED fires when the file is created, long before the write ends: wait for
    /// the size to stop moving and the writer to let go.
    fn settled(path: &Path) -> bool {
        let mut last = u64::MAX;
        for _ in 0..750 { // ~10 min, then give up: no thread waits forever on a file that never settles
            if !path.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(800));
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if size > 0 && size == last && free(path) {
                return true;
            }
            last = size;
        }
        false
    }

    fn settle_and_add(app: &AppHandle, path: PathBuf, kind: &'static str) {
        if is_media(&path) && settled(&path) && add(&path, kind, mtime_ms(&path), false) {
            let _ = app.emit("media-changed", ());
        }
    }

    /// What is already in the folder (recent files only), for the start or a missed burst.
    fn scan(app: &AppHandle, dir: &Path, kind: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut changed = false;
        for e in entries.flatten() {
            let p = e.path();
            if is_media(&p) && now_ms().saturating_sub(mtime_ms(&p)) < SCAN_MS && free(&p) {
                changed |= add(&p, kind, mtime_ms(&p), false);
            }
        }
        if changed {
            let _ = app.emit("media-changed", ());
        }
    }

    /// Blocks in ReadDirectoryChangesW: nothing runs between notifications.
    fn watch(app: AppHandle, dir: PathBuf, kind: &'static str) {
        scan(&app, &dir, kind);
        let wide: Vec<u16> = dir.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
        let Ok(h) = (unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_LIST_DIRECTORY.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        }) else {
            return;
        };
        // u32 so the buffer is DWORD-aligned, as the API requires.
        let mut buf = vec![0u32; 4096];
        loop {
            let mut got = 0u32;
            let r = unsafe {
                ReadDirectoryChangesW(
                    HANDLE(h.0),
                    buf.as_mut_ptr().cast(),
                    (buf.len() * 4) as u32,
                    false,
                    FILE_NOTIFY_CHANGE_FILE_NAME,
                    Some(&mut got),
                    None,
                    None,
                )
            };
            if r.is_err() {
                unsafe { let _ = CloseHandle(HANDLE(h.0)); }
                return;
            }
            if got == 0 {
                // Buffer overflowed: too many changes to list, look at the folder.
                scan(&app, &dir, kind);
                continue;
            }
            let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), got as usize) };
            let u32_at = |o: usize| bytes.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
            let mut off = 0usize;
            loop {
                let (Some(next), Some(action), Some(len)) = (u32_at(off), u32_at(off + 4), u32_at(off + 8)) else {
                    break;
                };
                // 1 = added, 5 = renamed to this name (a temp file given its final one).
                if action == 1 || action == 5 {
                    if let Some(raw) = bytes.get(off + 12..off + 12 + len as usize) {
                        let name: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                        let path = dir.join(String::from_utf16_lossy(&name));
                        let app = app.clone();
                        std::thread::spawn(move || settle_and_add(&app, path, kind));
                    }
                }
                if next == 0 {
                    break;
                }
                off += next as usize;
            }
        }
    }

    pub fn thumb(path: &str, px: u32) -> Result<Vec<u8>, String> {
        sta(|| unsafe {
            let item: IShellItemImageFactory =
                SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(|e| e.message())?;
            // Default flags: the file's own preview, or its icon when it has none.
            let bitmap = item
                .GetImage(SIZE { cx: px as i32, cy: px as i32 }, SIIGBF(0))
                .map_err(|e| e.message())?;
            let mut info = BITMAP::default();
            GetObjectW(bitmap.into(), size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut _));
            let (w, h) = (info.bmWidth, info.bmHeight);
            let mut out = Err("miniatura vazia".to_string());
            if w > 0 && h > 0 {
                // Top-down BGRA whatever way up the shell made it.
                let mut bi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -h,
                        biPlanes: 1,
                        biBitCount: 32,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut pixels = vec![0u8; (w * h * 4) as usize];
                let dc = GetDC(None);
                let lines = GetDIBits(dc, bitmap, 0, h as u32, Some(pixels.as_mut_ptr().cast()), &mut bi, DIB_RGB_COLORS);
                ReleaseDC(None, dc);
                if lines != 0 {
                    // The shell premultiplies alpha; an all-zero alpha means none at all.
                    let opaque = pixels.chunks_exact(4).all(|p| p[3] == 0);
                    for p in pixels.chunks_exact_mut(4) {
                        let a = p[3] as u32;
                        if opaque {
                            p[3] = 255;
                        } else if a != 0 && a != 255 {
                            for c in &mut p[..3] {
                                *c = (*c as u32 * 255 / a).min(255) as u8;
                            }
                        }
                        p.swap(0, 2);
                    }
                    let mut png_bytes = Vec::new();
                    let mut enc = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
                    enc.set_color(png::ColorType::Rgba);
                    enc.set_depth(png::BitDepth::Eight);
                    out = enc
                        .write_header()
                        .and_then(|mut wr| wr.write_image_data(&pixels))
                        .map(|_| png_bytes)
                        .map_err(|e| e.to_string());
                }
            }
            let _ = DeleteObject(bitmap.into());
            out
        })
    }

    pub fn open(path: &str) -> Result<(), String> {
        let code = sta(|| unsafe {
            ShellExecuteW(None, w!("open"), &HSTRING::from(path), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL).0 as usize
        });
        match code {
            33.. => Ok(()),
            // No app registered for it: Windows' own chooser.
            31 => open_with(path),
            _ => Err(format!("O Windows não conseguiu abrir o arquivo (código {code}).")),
        }
    }

    /// Windows' "Abrir com" chooser. Returns when it closes.
    pub fn open_with(path: &str) -> Result<(), String> {
        let file = HSTRING::from(path);
        sta(|| unsafe {
            let info = OPENASINFO {
                pcszFile: PCWSTR(file.as_ptr()),
                pcszClass: PCWSTR::null(),
                oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
            };
            SHOpenWithDialog(None, &info)
        })
        // 0x800704C7: the user closed the chooser.
        .or_else(|e| if e.code().0 as u32 == 0x8007_04C7 { Ok(()) } else { Err(e.message()) })
    }

    pub fn reveal(path: &str) -> Result<(), String> {
        // explorer returns 1 even on success, so only a failure to start is an error.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod sys {
    use tauri::AppHandle;

    const ONLY_WINDOWS: &str = "A mídia só está disponível no Windows.";

    pub fn start(_app: AppHandle) {}
    pub fn thumb(_path: &str, _px: u32) -> Result<Vec<u8>, String> {
        Err(ONLY_WINDOWS.into())
    }
    pub fn open(_path: &str) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }
    pub fn open_with(_path: &str) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }
    pub fn reveal(_path: &str) -> Result<(), String> {
        Err(ONLY_WINDOWS.into())
    }
}
