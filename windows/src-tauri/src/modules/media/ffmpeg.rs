// ffmpeg for the video/GIF tools: the one on PATH, or the pinned build the user chose to download
// into %LOCALAPPDATA%\Coucou\tools. Nothing is fetched unless the user clicked "Baixar".

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::tools;
use crate::core::settings;

/// Pinned build (gyan.dev "essentials" 7.1.1, mirrored on GitHub releases). Changing it means changing the hash.
pub const URL: &str = "https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip";
pub const SHA256: &str = "04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4";
pub const BYTES: u64 = 92_234_348;
const ENTRY: &str = "ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe";
const NO_WINDOW: u32 = 0x0800_0000;

pub fn tools_dir() -> PathBuf {
    settings::local_dir().join("tools")
}

/// First `ffmpeg.exe` in the PATH-style list.
pub fn find_in(path_var: &OsStr, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    std::env::split_paths(path_var).map(|d| d.join("ffmpeg.exe")).find(|p| exists(p))
}

/// PATH first (the user's own build wins), then the downloaded one.
pub fn locate() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|p| find_in(&p, |f| f.is_file()))
        .or_else(|| Some(tools_dir().join("ffmpeg.exe")).filter(|p| p.is_file()))
}

pub fn hash_ok(got: &str, want: &str) -> bool {
    got.eq_ignore_ascii_case(want)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn cmd(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    c.creation_flags(NO_WINDOW);
    c
}

fn duration_ms(exe: &Path, input: &Path) -> u64 {
    // `ffmpeg -i file` with no output prints the banner on stderr and exits 1.
    cmd(exe).args(["-hide_banner", "-nostdin", "-i"]).arg(input).stdout(Stdio::null()).stderr(Stdio::piped())
        .output().ok()
        .and_then(|o| tools::parse_duration_ms(&String::from_utf8_lossy(&o.stderr)))
        .unwrap_or(0)
}

/// Runs one ffmpeg op, reporting percent; kills the child and removes the partial file on cancel.
pub fn run(op: &str, input: &Path, output: &Path, cancel: &AtomicBool, progress: &dyn Fn(u8)) -> Result<(), String> {
    let exe = locate().ok_or("ffmpeg não encontrado")?;
    let args = tools::ffmpeg_args(op, input, output).ok_or("operação desconhecida")?;
    let total = duration_ms(&exe, input);
    let mut child = cmd(&exe).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("não consegui iniciar o ffmpeg: {e}"))?;
    let mut last = 255u8;
    for line in BufReader::new(child.stdout.take().expect("piped")).lines().map_while(Result::ok) {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(output);
            return Err("cancelled".into());
        }
        if let Some(ms) = tools::parse_progress_ms(&line) {
            let p = tools::percent(ms, total);
            if total > 0 && p != last {
                last = p;
                progress(p);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(output);
        return Err("cancelled".into());
    }
    if !status.success() {
        let _ = std::fs::remove_file(output);
        return Err(format!("o ffmpeg falhou ({})", status.code().map_or("?".into(), |c| c.to_string())));
    }
    Ok(())
}

/// Downloads the pinned zip, verifies SHA-256 BEFORE extracting, extracts only ffmpeg.exe with the system `tar`.
pub fn download(cancel: &AtomicBool, progress: &dyn Fn(u8)) -> Result<PathBuf, String> {
    let dir = tools_dir();
    crate::core::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join("ffmpeg-download.zip.part");
    let res = fetch(&zip, cancel, progress).and_then(|()| extract(&zip, &dir));
    let _ = std::fs::remove_file(&zip);
    res
}

fn fetch(zip: &Path, cancel: &AtomicBool, progress: &dyn Fn(u8)) -> Result<(), String> {
    let mut file = std::fs::File::create(zip).map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let mut got = 0u64;
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
        let mut resp = client.get(URL).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("download falhou: {e}"))?;
        let mut last = 255u8;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), resp.chunk())
            .await.map_err(|_| "download parou de responder".to_string())?.map_err(|e| e.to_string())?
        {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".to_string());
            }
            got += chunk.len() as u64;
            if got > BYTES + (1 << 20) {
                return Err("o arquivo é maior que o esperado".into());
            }
            sha.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            let p = (got * 100 / BYTES).min(99) as u8;
            if p != last {
                last = p;
                progress(p);
            }
        }
        Ok::<(), String>(())
    })?;
    file.flush().map_err(|e| e.to_string())?;
    if got != BYTES || !hash_ok(&hex(&sha.finalize()), SHA256) {
        return Err("o arquivo baixado não confere com o SHA-256 esperado; descartado".into());
    }
    Ok(())
}

fn extract(zip: &Path, dir: &Path) -> Result<PathBuf, String> {
    let tar = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| "C:\\Windows".into()).join("System32").join("tar.exe");
    let st = cmd(&tar).arg("-xf").arg(zip).arg("-C").arg(dir).args(["--strip-components=2", ENTRY])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|e| format!("não consegui extrair: {e}"))?;
    let exe = dir.join("ffmpeg.exe");
    if !st.success() || !exe.is_file() {
        return Err("a extração falhou".into());
    }
    let mut magic = [0u8; 2];
    std::fs::File::open(&exe).and_then(|mut f| f.read_exact(&mut magic)).map_err(|e| e.to_string())?;
    if &magic != b"MZ" {
        let _ = std::fs::remove_file(&exe);
        return Err("o ffmpeg extraído não é um executável".into());
    }
    Ok(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_first_on_path() {
        let var = std::env::join_paths(["C:\\a", "C:\\b", "C:\\c"]).unwrap();
        let hit = find_in(&var, |p| p.starts_with("C:\\b") || p.starts_with("C:\\c"));
        assert_eq!(hit, Some(PathBuf::from("C:\\b\\ffmpeg.exe")));
        assert_eq!(find_in(&var, |_| false), None);
    }

    #[test]
    fn pinned_hash_shape() {
        assert_eq!(SHA256.len(), 64);
        assert!(hash_ok(&SHA256.to_uppercase(), SHA256));
        assert!(!hash_ok("00", SHA256));
        assert_eq!(hex(&Sha256::digest(b"abc"))[..8], *"ba7816bf");
    }
}
