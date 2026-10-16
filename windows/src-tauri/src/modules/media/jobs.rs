// Tool jobs: one worker thread per job, started when the user asks and gone when it ends.
// The thread is the module's own (ModuleCtx spawner), so stopping the module cancels and joins it.
// Progress, result and errors go out as the `media-tool` event; results are written next to the
// source under a name that does not exist yet.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{ffmpeg, imageops, ocr, tools};
use crate::core::host::{ModuleCtx, Spawner};
use crate::core::log;

struct Runtime {
    spawner: Spawner,
    app: AppHandle,
}

static RT: Mutex<Option<Runtime>> = Mutex::new(None);
/// Cancel flags of the jobs in flight, by id.
static JOBS: Mutex<Option<HashMap<u64, Arc<AtomicBool>>>> = Mutex::new(None);
/// Jobs in flight; beyond MAX_JOBS the answer is "ocupado".
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
const MAX_JOBS: usize = 2;
static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn init(ctx: &ModuleCtx) {
    *RT.lock().unwrap() = Some(Runtime { spawner: ctx.spawner(), app: ctx.app.clone() });
}

/// Module stop: no new jobs; the ones running see `stop` (the spawner's flag) and are joined by the host.
pub fn shutdown() {
    *RT.lock().unwrap() = None;
    for flag in JOBS.lock().unwrap().take().into_iter().flatten().map(|(_, f)| f) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    pub id: u64,
    pub op: String,
    /// "progress", "done", "error" or "cancelled".
    pub state: &'static str,
    pub pct: u8,
    pub out: Option<String>,
    pub text: Option<String>,
    pub msg: Option<String>,
}

#[derive(Default)]
pub struct Done {
    pub out: Option<PathBuf>,
    pub text: Option<String>,
}

pub fn cancel(id: u64) {
    if let Some(f) = JOBS.lock().unwrap().as_ref().and_then(|j| j.get(&id)) {
        f.store(true, Ordering::SeqCst);
    }
}

/// Starts `work` on its own thread. Returns the job id; the thread ends when `work` returns.
pub fn spawn<F>(op: &str, work: F) -> Result<u64, String>
where
    F: FnOnce(&AtomicBool, &dyn Fn(u8)) -> Result<Done, String> + Send + 'static,
{
    let rt = RT.lock().unwrap();
    let rt = rt.as_ref().ok_or("módulo desligado")?;
    if ACTIVE.fetch_add(1, Ordering::SeqCst) >= MAX_JOBS {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
        return Err("ocupado: espere a ferramenta atual terminar".into());
    }
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    JOBS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, cancel.clone());
    let (app, op) = (rt.app.clone(), op.to_string());
    rt.spawner.spawn(move |_stop| {
        // shutdown() raises every cancel flag, so a stopping module ends its jobs through the same path.
        let ev = |state, pct, d: Done, msg: Option<String>| {
            let _ = app.emit("media-tool", ToolEvent {
                id, op: op.clone(), state, pct,
                out: d.out.map(|p| p.to_string_lossy().into_owned()), text: d.text, msg,
            });
        };
        let progress = |p: u8| ev("progress", p, Done::default(), None);
        match work(&cancel, &progress) {
            Ok(d) => ev("done", 100, d, None),
            Err(m) if m == "cancelled" || cancel.load(Ordering::SeqCst) => ev("cancelled", 0, Done::default(), None),
            Err(m) => {
                log::line(format!("media tool {op} failed: {m}"));
                ev("error", 0, Done::default(), Some(m))
            }
        }
        if let Some(j) = JOBS.lock().unwrap().as_mut() { j.remove(&id); }
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(id)
}

/// What `media_tool_info` tells the UI about a file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub kind: &'static str,
    pub size: u64,
    pub size_text: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub pages: Option<u32>,
    pub ops: &'static [&'static str],
    pub ffmpeg: bool,
}

pub fn info(path: &str) -> Result<Info, String> {
    let p = Path::new(path);
    if !tools::is_local_abs(p) {
        return Err("caminho não permitido".into());
    }
    let meta = std::fs::metadata(p).map_err(|_| "arquivo não encontrado".to_string())?;
    if !meta.is_file() {
        return Err("não é um arquivo".into());
    }
    let kind = tools::kind_of(p);
    let dims = (kind == tools::Kind::Image).then(|| imageops::dimensions(p)).flatten();
    let pages = (kind == tools::Kind::Pdf && meta.len() <= 64 << 20)
        .then(|| std::fs::read(p).ok().map(|b| tools::count_pdf_pages(&b)))
        .flatten();
    Ok(Info {
        kind: match kind { tools::Kind::Image => "image", tools::Kind::Video => "video", tools::Kind::Pdf => "pdf", tools::Kind::Other => "other" },
        size: meta.len(),
        size_text: tools::human_size(meta.len()),
        width: dims.map(|d| d.0),
        height: dims.map(|d| d.1),
        pages,
        ops: tools::ops_for(kind, &tools::ext_of(p)),
        ffmpeg: ffmpeg::locate().is_some(),
    })
}

/// Validates and starts one tool. Every check is repeated here: the webview is not trusted.
pub fn run(op: &str, path: &str, arg: &str) -> Result<u64, String> {
    let src = PathBuf::from(path);
    if !tools::is_local_abs(&src) {
        return Err("caminho não permitido".into());
    }
    if !src.is_file() {
        return Err("arquivo não encontrado".into());
    }
    if !tools::ops_for(tools::kind_of(&src), &tools::ext_of(&src)).contains(&op) {
        return Err("esta ferramenta não serve para este tipo de arquivo".into());
    }
    if tools::needs_ffmpeg(op) && ffmpeg::locate().is_none() {
        return Err("ffmpeg não encontrado".into());
    }
    let (suffix, ext) = tools::output_name(op, arg, &tools::ext_of(&src)).ok_or("opção inválida")?;
    let (op_s, arg_s) = (op.to_string(), arg.to_string());
    spawn(op, move |cancel, progress| {
        let dir = src.parent().unwrap_or(Path::new("."));
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("arquivo");
        // Claimed with create_new for ffmpeg/OCR: two jobs never share a name, and only files this run made are deleted.
        let claim = matches!(op_s.as_str(), "ocr" | "gif" | "vcompress" | "audio");
        let out = reserve(dir, stem, &suffix, &ext, claim)?;
        // A claimed output is empty until the work succeeds: never leave a 0-byte file behind.
        let res = (|| -> Result<Done, String> {
            let check = || if cancel.load(Ordering::SeqCst) { Err("cancelled".to_string()) } else { Ok(()) };
            check()?;
            match op_s.as_str() {
                "clipboard" => imageops::to_clipboard(&src).map(|()| Done::default()),
                "ocr" => {
                    let text = ocr::recognize(&src)?;
                    check()?;
                    if text.trim().is_empty() {
                        return Err("Nenhum texto encontrado na imagem.".into());
                    }
                    std::fs::write(&out, &text).map_err(|e| e.to_string())?;
                    Ok(Done { out: Some(out.clone()), text: Some(text) })
                }
                "gif" | "vcompress" | "audio" => ffmpeg::run(&op_s, &src, &out, cancel, progress).map(|()| Done { out: Some(out.clone()), text: None }),
                _ => {
                    imageops::run(&op_s, &src, &arg_s, &out)?;
                    // Lossless WebP can grow; never keep a bigger "compressed" file silently.
                    if op_s == "compress" && std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) >= std::fs::metadata(&src).map(|m| m.len()).unwrap_or(u64::MAX) {
                        let _ = std::fs::remove_file(&out);
                        return Err("Não ficou menor que o original; nada foi salvo.".into());
                    }
                    Ok(Done { out: Some(out.clone()), text: None })
                }
            }
        })();
        discard_claimed(res.is_err(), claim, &out);
        res
    })
}

/// The next free `stem<suffix>.ext`; with `claim` the file is created empty so nobody else can take the name.
fn reserve(dir: &Path, stem: &str, suffix: &str, ext: &str, claim: bool) -> Result<PathBuf, String> {
    for _ in 0..50 {
        let p = tools::unique_path(dir, stem, suffix, ext, |p| p.exists());
        if !claim {
            return Ok(p);
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => return Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("não consegui reservar um nome para o resultado".into())
}

pub fn download_ffmpeg() -> Result<u64, String> {
    if ffmpeg::locate().is_some() {
        return Err("o ffmpeg já está disponível".into());
    }
    spawn("ffmpeg", |cancel, progress| ffmpeg::download(cancel, progress).map(|p| Done { out: Some(p), text: None }))
}

/// A claimed output is empty until the work succeeds: remove it when the work failed.
fn discard_claimed(failed: bool, claimed: bool, out: &std::path::Path) {
    if failed && claimed {
        let _ = std::fs::remove_file(out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_claimed_job_leaves_no_empty_output() {
        let dir = std::env::temp_dir().join(format!("coucou-jobs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("a-texto.txt");
        std::fs::write(&out, b"").unwrap();
        discard_claimed(false, true, &out); // success keeps it
        assert!(out.exists());
        discard_claimed(true, false, &out); // not claimed by this run: never touched
        assert!(out.exists());
        discard_claimed(true, true, &out); // failed and claimed: removed
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn info_rejects_unc() {
        assert!(info(r"\server\share.png").is_err());
    }
}
