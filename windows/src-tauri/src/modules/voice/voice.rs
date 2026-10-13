// Voice input (English): a global hotkey toggles the microphone, one phrase is cut on ~1 s of silence
// (or 25 s), transcribed on-device by Cactus' `needle.exe` + `whistle.cact` (child process on a temp WAV,
// telemetry off), and the text goes to the island, which shows it on a card. Nothing is sent anywhere by
// this module; the model files are fetched only on the Settings button, pinned and SHA-256 checked.
//
// shortcut: one phrase per hotkey press and a fixed loudness threshold (QUIET); a noisy room or a
// multi-sentence dictation needs an adaptive threshold and a continuous mode.

use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

use crate::core::host::{blocking, ModuleCtx, ModuleHost};
use crate::core::hotkeys;

const RATE: usize = 16_000;
const MAX_PHRASE: usize = 25 * RATE;
const PAUSE: usize = RATE; // ~1 s of quiet ends the phrase
const NO_SPEECH: usize = 30 * RATE; // mic is closed if nobody speaks for this long
const QUIET: f32 = 0.012;
const ENGINE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub ready: bool,
    pub listening: bool,
    /// Why a hotkey could not be registered ("" = fine).
    pub hotkey_error: String,
}

struct ModelFile {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    max: usize,
}
// Pinned to repository revisions; copied from the Lintel reference (whistle.rs).
const FILES: [ModelFile; 2] = [
    ModelFile {
        name: "whistle.cact",
        url: "https://huggingface.co/Cactus-Compute/whistle/resolve/ca5287601bef25af26dcf2e1b2bdc0843a7c19e5/whistle.cact",
        sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
        max: 20 << 20,
    },
    ModelFile {
        name: "needle.exe",
        url: "https://huggingface.co/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b/windows-x86_64/needle.exe",
        sha256: "47cd411a022d22e393d87ce091848fd446e6d25df2ce31b12a7328337557c85b",
        max: 4 << 20,
    },
];

fn hex(d: impl AsRef<[u8]>) -> String {
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
fn dir() -> PathBuf {
    crate::core::settings::local_dir().join("voice")
}
/// The hash check reads ~24 MB: remember a pass (download() resets it).
static VERIFIED: AtomicBool = AtomicBool::new(false);
fn ready(dir: &Path) -> bool {
    if VERIFIED.load(Ordering::SeqCst) {
        return true;
    }
    let ok = FILES.iter().all(|f| std::fs::read(dir.join(f.name)).is_ok_and(|b| hex(Sha256::digest(&b)) == f.sha256));
    VERIFIED.store(ok, Ordering::SeqCst);
    ok
}

fn emit_state(app: &AppHandle, state: &str, message: &str) {
    let _ = app.emit("voice-state", serde_json::json!({ "state": state, "message": message }));
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn voice_start(app: AppHandle) -> Result<(), String> {
    start(&app)
}

#[tauri::command]
pub fn voice_stop() {
    stop()
}

#[tauri::command]
pub async fn voice_model_status() -> VoiceStatus {
    blocking(|| VoiceStatus {
        ready: ready(&dir()),
        listening: CAPTURING.load(Ordering::SeqCst),
        hotkey_error: hotkeys::error(),
    })
    .await
    .unwrap_or_default()
}

/// Settings → "Baixar modelo". Emits `voice-download` {file, received, total} as it goes.
#[tauri::command]
pub async fn voice_download_model(app: AppHandle) -> Result<(), String> {
    app.state::<ModuleHost>().require("voice")?;
    download(app).await
}

// ── Capture + transcription ──────────────────────────────────────────────────

static CAPTURING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);

pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

/// The hotkey: stops a phrase in progress, or starts one. Runs on the main thread.
pub fn on_hotkey(app: &AppHandle) {
    if CAPTURING.load(Ordering::SeqCst) {
        return stop();
    }
    if let Err(e) = start(app) {
        emit_state(app, "error", &e);
    }
}

fn start(app: &AppHandle) -> Result<(), String> {
    let host = app.state::<ModuleHost>();
    host.require("voice")?;
    let ctx: Arc<ModuleCtx> = host.ctx("voice").ok_or("O módulo Voz está desligado nas Configurações.")?;
    let d = dir();
    if !ready(&d) {
        return Err("Modelo de voz ausente: baixe em Configurações → Voz.".into());
    }
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    STOP.store(false, Ordering::SeqCst);
    let app = app.clone();
    ctx.spawn(move |module_stop| {
        emit_state(&app, "listening", "");
        let result = record(&app, &module_stop).and_then(|pcm| match pcm {
            Some(pcm) => {
                emit_state(&app, "transcribing", "");
                transcribe(&d, &pcm, &module_stop).map(Some)
            }
            None => Ok(None),
        });
        CAPTURING.store(false, Ordering::SeqCst);
        if module_stop.load(Ordering::SeqCst) {
            return; // the module went off: the card is gone too
        }
        match result {
            Ok(Some(t)) if !t.0.is_empty() => {
                let _ = app.emit("voice-text", serde_json::json!({ "text": t.0, "language": t.1 }));
                emit_state(&app, "idle", "");
            }
            Ok(_) => emit_state(&app, "idle", ""),
            Err(m) => emit_state(&app, "error", &m),
        }
    });
    Ok(())
}

/// Records until one phrase is cut, the user stops, or nobody speaks for 30 s. None = nothing said.
/// The microphone is open (and the 30 ms loop runs) only inside this function.
fn record(app: &AppHandle, module_stop: &AtomicBool) -> Result<Option<Vec<f32>>, String> {
    let werr = |e: windows::core::Error| format!("Microfone: {}", e.message());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(werr)?;
        let dev = en.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(werr)?;
        let ac: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(werr)?;
        let fmt = WAVEFORMATEX {
            wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: 1,
            nSamplesPerSec: RATE as u32,
            nAvgBytesPerSec: RATE as u32 * 4,
            nBlockAlign: 4,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        // Windows converts to 16 kHz mono itself, so there is no resampling code here.
        ac.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            50_000_000,
            0,
            &fmt,
            None,
        )
        .map_err(werr)?;
        let cap: IAudioCaptureClient = ac.GetService().map_err(werr)?;
        ac.Start().map_err(werr)?;

        let (mut phrase, mut quiet, mut spoke, mut waited) = (Vec::<f32>::new(), 0usize, false, 0usize);
        let (mut peak, mut ticks) = (0f32, 0u32);
        let mut out = Ok(());
        'run: while !STOP.load(Ordering::SeqCst) && !module_stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(30));
            ticks += 1;
            if ticks % 3 == 0 {
                let _ = app.emit("voice-level", (peak * 6.0).min(1.0));
                peak = 0.0;
            }
            loop {
                match cap.GetNextPacketSize() {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(e) => {
                        out = Err(werr(e));
                        break 'run;
                    }
                }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                if let Err(e) = cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None) {
                    out = Err(werr(e));
                    break 'run;
                }
                let chunk: Vec<f32> = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    vec![0.0; frames as usize]
                } else {
                    std::slice::from_raw_parts(data as *const f32, frames as usize).to_vec()
                };
                let _ = cap.ReleaseBuffer(frames);
                let rms = (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len().max(1) as f32).sqrt();
                peak = peak.max(rms);
                if rms < QUIET {
                    quiet += chunk.len();
                } else {
                    quiet = 0;
                    spoke = true;
                }
                waited += chunk.len();
                phrase.extend(chunk);
                if spoke && (quiet >= PAUSE || phrase.len() >= MAX_PHRASE) {
                    break 'run;
                }
                if !spoke {
                    if phrase.len() > PAUSE {
                        phrase.drain(..phrase.len() - PAUSE / 2); // leading silence is not kept
                    }
                    if waited >= NO_SPEECH {
                        break 'run;
                    }
                }
            }
        }
        let _ = ac.Stop(); // the microphone is closed before the engine runs
        out?;
        Ok(spoke.then_some(phrase))
    }
}

fn wav(pcm: &[f32]) -> Vec<u8> {
    let n = (pcm.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + n as usize);
    v.extend(b"RIFF");
    v.extend((36 + n).to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(16000u32.to_le_bytes());
    v.extend(32000u32.to_le_bytes());
    v.extend(2u16.to_le_bytes());
    v.extend(16u16.to_le_bytes());
    v.extend(b"data");
    v.extend(n.to_le_bytes());
    for s in pcm {
        v.extend(((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    v
}

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// (text, language). The clip lives in a temp file only while the engine runs.
fn transcribe(dir: &Path, pcm: &[f32], module_stop: &AtomicBool) -> Result<(String, String), String> {
    if !ready(dir) {
        return Err("Modelo de voz ausente ou corrompido.".into());
    }
    let tmp = Temp(std::env::temp_dir().join(format!("coucou-voice-{}.wav", std::process::id())));
    std::fs::write(&tmp.0, wav(pcm)).map_err(|e| e.to_string())?;
    let mut child = Command::new(dir.join("needle.exe"))
        .arg("--model")
        .arg(dir.join("whistle.cact"))
        .arg("--audio")
        .arg(&tmp.0)
        .env("NEEDLE_TELEMETRY", "0")
        .env("DO_NOT_TRACK", "1")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| e.to_string())?;
    // Read on a thread so a chatty engine cannot fill the pipe while we wait on it.
    let mut pipe = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(p) = pipe.as_mut() {
            let _ = p.read_to_end(&mut out);
        }
        out
    });
    let deadline = Instant::now() + ENGINE_TIMEOUT;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline && !module_stop.load(Ordering::SeqCst) => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("O motor de voz não respondeu a tempo.".into());
            }
        }
    };
    drop(tmp);
    let stdout = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    let v = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok().filter(|v| v.get("text").is_some()))
        .ok_or_else(|| format!("O motor de voz não devolveu texto (código {code:?})."))?;
    Ok((v["text"].as_str().unwrap_or("").trim().to_string(), v["language"].as_str().unwrap_or("").to_string()))
}

// ── Download (Settings button only) ──────────────────────────────────────────

async fn download(app: AppHandle) -> Result<(), String> {
    VERIFIED.store(false, Ordering::SeqCst); // files are about to change
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    // Redirects (Hugging Face → its CDN) are followed only over https.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.url().scheme() == "https" && a.previous().len() < 5 { a.follow() } else { a.error("redirecionamento fora de https") }
        }))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    for f in &FILES {
        let path = d.join(f.name);
        if std::fs::read(&path).is_ok_and(|b| hex(Sha256::digest(&b)) == f.sha256) {
            continue;
        }
        let mut resp = client.get(f.url).send().await.map_err(|e| e.to_string())?;
        if resp.url().scheme() != "https" {
            return Err("download redirecionado para fora de https".into());
        }
        if !resp.status().is_success() {
            return Err(format!("{}: HTTP {}", f.name, resp.status().as_u16()));
        }
        let total = resp.content_length().unwrap_or(0);
        let part = d.join(format!("{}.part", f.name));
        let fetched: Result<String, String> = async {
            let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let (mut hash, mut received) = (Sha256::new(), 0u64);
            while let Some(piece) = resp.chunk().await.map_err(|e| e.to_string())? {
                received += piece.len() as u64;
                if received > f.max as u64 {
                    return Err(format!("{}: maior do que deveria", f.name));
                }
                hash.update(&piece);
                out.write_all(&piece).map_err(|e| e.to_string())?;
                let _ = app.emit("voice-download", serde_json::json!({ "file": f.name, "received": received, "total": total }));
            }
            Ok(hex(hash.finalize()))
        }
        .await;
        match fetched {
            Ok(h) if h == f.sha256 => std::fs::rename(&part, &path).map_err(|e| e.to_string())?,
            other => {
                let _ = std::fs::remove_file(&part);
                return Err(other.err().unwrap_or_else(|| format!("{}: checksum não confere, arquivo apagado", f.name)));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_and_length() {
        let w = wav(&[0.0, 1.0, -1.0]);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(w.len(), 44 + 6);
        assert_eq!(i16::from_le_bytes([w[46], w[47]]), 32767);
    }

    #[test]
    fn pinned_files_are_https_sha256() {
        for f in &FILES {
            assert!(f.url.starts_with("https://"));
            assert_eq!(f.sha256.len(), 64);
        }
    }
}
