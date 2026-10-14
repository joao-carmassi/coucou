// Mídia commands, same names and argument shapes as at m3-ok.

use tauri::AppHandle;

use super::{capture, media};
use crate::core::host::blocking;
use crate::core::log;
use crate::core::inbox::{self, DroppedFile};

/// Screenshots the window under the cursor into the inbox (Mochi dragged onto it).
#[tauri::command]
pub async fn attach_window(handle: AppHandle) -> Result<DroppedFile, String> {
    let (app, w, h, rgb) = capture::capture_under_cursor()?;
    let file = inbox::save_capture(Some(&handle), &app, w, h, &rgb)?;
    log::line(format!("window attached: {app} {w}x{h}"));
    Ok(file)
}

#[tauri::command]
pub async fn media_list() -> Result<Vec<media::MediaItem>, String> {
    blocking(media::list).await
}

/// The file's preview as PNG bytes.
#[tauri::command]
pub async fn media_thumb(path: String, px: u32) -> Result<tauri::ipc::Response, String> {
    blocking(move || media::thumb(&path, px.clamp(32, 512))).await?.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn media_open(path: String) -> Result<(), String> {
    blocking(move || media::open(&path)).await?
}

#[tauri::command]
pub async fn media_open_with(path: String) -> Result<(), String> {
    blocking(move || media::open_with(&path)).await?
}

#[tauri::command]
pub async fn media_reveal(path: String) -> Result<(), String> {
    blocking(move || media::reveal(&path)).await?
}

/// Off the list only; the file stays where it is.
#[tauri::command]
pub async fn media_remove(path: String) -> Result<(), String> {
    blocking(move || media::remove(&path)).await
}
