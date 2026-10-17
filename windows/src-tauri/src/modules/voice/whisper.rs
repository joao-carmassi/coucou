// Offline whisper.cpp engine (F42). Nothing runs until the user clicks the download in Settings:
// the pinned `whisper-cli` build and the pinned model are fetched over https, size + SHA-256 checked, then used on-device.
// Nothing is sent anywhere afterwards; audio lives in a temp WAV only while the engine runs.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::core::archive::{extract_zip, hex, sha256_file};

pub struct Pinned {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

// whisper.cpp build tag b5454 (the v1.9.5 release carries no binaries; the Windows zips hang off the build tags).
pub const BIN: Pinned = Pinned {
    name: "whisper-bin-x64.zip",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
    size: 8_928_640,
    sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
};
// Hugging Face revision of ggerganov/whisper.cpp (not `main`).
pub const MODEL: Pinned = Pinned {
    name: "ggml-base-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin",
    size: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
};
const EXE: &str = "Release/whisper-cli.exe"; // the zip keeps everything under Release/

pub fn dir() -> PathBuf {
    crate::core::settings::local_dir().join("voice").join("whisper")
}
pub fn exe() -> PathBuf {
    dir().join("bin").join(EXE)
}
pub fn model() -> PathBuf {
    dir().join(MODEL.name)
}

/// Hashing the model reads ~60 MB: remember a pass (download() resets it).
static VERIFIED: AtomicBool = AtomicBool::new(false);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);

pub fn ready() -> bool {
    if VERIFIED.load(Ordering::SeqCst) {
        return true;
    }
    let ok = exe().is_file() && sha256_file(&model()).is_ok_and(|h| h == MODEL.sha256);
    VERIFIED.store(ok, Ordering::SeqCst);
    ok
}

/// Pure: command line for one take. `lang` outside the allowlist becomes "auto".
pub fn args(lang: &str, wav: &Path, model: &Path, threads: u32) -> Vec<OsString> {
    let lang = if super::cfg::LANGS.contains(&lang) { lang } else { "auto" };
    let mut v: Vec<OsString> = vec!["-m".into(), model.into(), "-f".into(), wav.into(), "-l".into(), lang.into()];
    v.extend(["-nt", "-np", "-t"].map(OsString::from));
    v.push(threads.to_string().into());
    v
}

/// Pure: joins the text lines, dropping empty ones and non-speech markers such as "[BLANK_AUDIO]" or "(música)".
pub fn parse_stdout(s: &str) -> String {
    let marker = |l: &str| (l.starts_with('[') && l.ends_with(']')) || (l.starts_with('(') && l.ends_with(')'));
    s.lines().map(str::trim).filter(|l| !l.is_empty() && !marker(l)).collect::<Vec<_>>().join(" ")
}

pub fn threads() -> u32 {
    std::thread::available_parallelism().map_or(2, |n| n.get().min(4)) as u32
}

struct Busy;
impl Drop for Busy {
    fn drop(&mut self) {
        DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

/// Settings button. Emits `voice-download` {file, received, total}. Files already good are skipped.
pub async fn download(app: AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("já há um download em andamento".into());
    }
    let _busy = Busy;
    VERIFIED.store(false, Ordering::SeqCst); // files are about to change
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    // Redirects (GitHub and Hugging Face go through their CDNs) are followed only over https.
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() < 5 { a.follow() } else { a.error("redirecionamentos demais") }
        }))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;

    if !sha256_file(&model()).is_ok_and(|h| h == MODEL.sha256) {
        let part = d.join(format!("{}.part", MODEL.name));
        fetch(&client, &app, &MODEL, &part).await?;
        std::fs::rename(&part, model()).map_err(|e| e.to_string())?;
    }
    if !exe().is_file() {
        let part = d.join(format!("{}.part", BIN.name));
        fetch(&client, &app, &BIN, &part).await?;
        let tmp = d.join("bin.tmp");
        let _ = std::fs::remove_dir_all(&tmp);
        let (zip, out) = (part.clone(), tmp.clone());
        let unpacked = crate::core::host::blocking(move || extract_zip(&zip, &out)).await?;
        let _ = std::fs::remove_file(&part);
        if let Err(e) = unpacked {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
        if !tmp.join(EXE).is_file() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("o zip não contém o whisper-cli.exe".into());
        }
        let fin = d.join("bin");
        let _ = std::fs::remove_dir_all(&fin);
        std::fs::rename(&tmp, &fin).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Streams `p` into `part`, hashing as it goes; a wrong size or hash deletes the file.
async fn fetch(client: &reqwest::Client, app: &AppHandle, p: &Pinned, part: &Path) -> Result<(), String> {
    let mut resp = client.get(p.url).send().await.map_err(|_| format!("{}: falha ao baixar", p.name))?;
    if !resp.status().is_success() {
        return Err(format!("{}: HTTP {}", p.name, resp.status().as_u16()));
    }
    let res: Result<(), String> = async {
        let mut out = std::fs::File::create(part).map_err(|e| e.to_string())?;
        let (mut hash, mut got) = (Sha256::new(), 0u64);
        while let Some(piece) = resp.chunk().await.map_err(|_| format!("{}: falha ao baixar", p.name))? {
            got += piece.len() as u64;
            if got > p.size {
                return Err(format!("{}: maior do que deveria", p.name));
            }
            hash.update(&piece);
            out.write_all(&piece).map_err(|e| e.to_string())?;
            let _ = app.emit("voice-download", serde_json::json!({ "file": p.name, "received": got, "total": p.size }));
        }
        if got != p.size || hex(&hash.finalize()) != p.sha256 {
            return Err(format!("{}: checksum não confere, arquivo apagado", p.name));
        }
        Ok(())
    }
    .await;
    if res.is_err() {
        let _ = std::fs::remove_file(part);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_allowlist_and_shape() {
        let a = |l: &str| args(l, Path::new("a.wav"), Path::new("m.bin"), 4).iter().map(|s| s.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(a("pt"), ["-m", "m.bin", "-f", "a.wav", "-l", "pt", "-nt", "-np", "-t", "4"]);
        assert_eq!(a("klingon")[5], "auto");
        assert_eq!(a("--output-file")[5], "auto", "an option-looking value never reaches the command line");
    }

    #[test]
    fn stdout_keeps_speech_only() {
        assert_eq!(parse_stdout("\r\n Olá, tudo bem?\r\n"), "Olá, tudo bem?");
        assert_eq!(parse_stdout(" [BLANK_AUDIO]\n"), "");
        assert_eq!(parse_stdout(" (música)\n Primeira.\n\n Segunda.\n"), "Primeira. Segunda.");
        assert_eq!(parse_stdout(""), "");
    }

    #[test]
    fn pinned_constants_are_https_sha256() {
        for p in [&BIN, &MODEL] {
            assert!(p.url.starts_with("https://"));
            assert_eq!(p.sha256.len(), 64);
            assert!(p.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(p.size > 0);
        }
        assert!(BIN.url.contains("/b5454/"), "pinned to the build tag");
        assert!(MODEL.url.contains("/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/"), "pinned to a revision, not main");
    }
}
