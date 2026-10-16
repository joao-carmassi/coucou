// Mídia commands, same names and argument shapes as at m3-ok.

use tauri::AppHandle;

use super::{capture, ffmpeg, jobs, media, tools};
use crate::core::host::blocking;
use crate::core::log;
use crate::core::inbox::{self, DroppedFile};

/// Screenshots the window under the cursor into the inbox (Mochi dragged onto it).
#[tauri::command]
pub async fn media_attach_window(handle: AppHandle) -> Result<DroppedFile, String> {
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

/// What a file can be asked to do (kind, size, dimensions, pages, tool ids).
#[tauri::command]
pub async fn media_tool_info(path: String) -> Result<jobs::Info, String> {
    blocking(move || jobs::info(&path)).await?
}

/// Starts a tool on a worker thread; progress and the result arrive as `media-tool` events.
#[tauri::command]
pub async fn media_tool_run(op: String, path: String, arg: Option<String>) -> Result<u64, String> {
    blocking(move || jobs::run(&op, &path, arg.as_deref().unwrap_or(""))).await?
}

#[tauri::command]
pub fn media_tool_cancel(id: u64) {
    jobs::cancel(id);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub path: Option<String>,
    pub url: &'static str,
    pub bytes: u64,
    pub size_text: String,
    pub sha256: &'static str,
}

/// Where ffmpeg is, and what the opt-in download would fetch.
#[tauri::command]
pub async fn media_ffmpeg_status() -> Result<FfmpegStatus, String> {
    blocking(|| FfmpegStatus {
        path: ffmpeg::locate().map(|p| p.to_string_lossy().into_owned()),
        url: ffmpeg::URL,
        bytes: ffmpeg::BYTES,
        size_text: tools::human_size(ffmpeg::BYTES),
        sha256: ffmpeg::SHA256,
    })
    .await
}

/// Only ever called from the user's click on "Baixar ffmpeg".
#[tauri::command]
pub async fn media_ffmpeg_download() -> Result<u64, String> {
    blocking(jobs::download_ffmpeg).await?
}
