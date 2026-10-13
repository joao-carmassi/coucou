// Voice input (English): a global hotkey toggles the microphone, one phrase is cut on ~1 s of silence
// (or 25 s), transcribed on-device by Cactus' `needle.exe` + `whistle.cact` (child process on a temp WAV,
// telemetry off), and the text goes to the island, which routes it. Nothing is sent anywhere by this
// module; the model files are fetched only on the Settings button, pinned and SHA-256 checked.
//
// The same hotkey thread also owns the "go to alert" hotkey, which only emits `go-to-alert`.
//
// shortcut: one phrase per hotkey press and a fixed loudness threshold (QUIET); a noisy room or a
// multi-sentence dictation needs an adaptive threshold and a continuous mode.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::settings::Settings;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub ready: bool,
    pub listening: bool,
    /// Why a hotkey could not be registered ("" = fine).
    pub hotkey_error: String,
}

/// Normalises "ctrl + alt+v" to "Ctrl+Alt+V"; falls back to `default` when it is not a hotkey.
/// An empty string stays empty (the hotkey is off).
pub fn clean_hotkey(s: &str, default: &str) -> String {
    if s.trim().is_empty() {
        return String::new();
    }
    match parse_hotkey(s) {
        Some(_) => s.split('+').map(|t| {
            let t = t.trim();
            let mut c = t.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
        }).collect::<Vec<_>>().join("+"),
        None => default.to_string(),
    }
}

/// (modifiers: 1 Alt, 2 Ctrl, 4 Shift, 8 Win — the MOD_* values, virtual-key). Needs a modifier.
fn parse_hotkey(s: &str) -> Option<(u32, u32)> {
    let (mut mods, mut key) = (0u32, None);
    for tok in s.split('+').map(|t| t.trim().to_ascii_lowercase()) {
        match tok.as_str() {
            "alt" => mods |= 1,
            "ctrl" | "control" => mods |= 2,
            "shift" => mods |= 4,
            "win" | "super" | "meta" => mods |= 8,
            "space" => key = Some(0x20),
            t if t.len() == 1 && t.as_bytes()[0].is_ascii_alphanumeric() => key = Some(t.to_ascii_uppercase().as_bytes()[0] as u32),
            t if t.starts_with('f') && t[1..].parse::<u32>().is_ok_and(|n| (1..=24).contains(&n)) => {
                key = Some(0x70 + t[1..].parse::<u32>().unwrap() - 1)
            }
            _ => return None,
        }
    }
    if mods == 0 {
        return None;
    }
    key.map(|k| (mods, k))
}

#[tauri::command]
pub fn voice_start(app: AppHandle) -> Result<(), String> {
    imp::start(&app)
}

#[tauri::command]
pub fn voice_stop() {
    imp::stop()
}

#[tauri::command]
pub async fn voice_model_status() -> VoiceStatus {
    tauri::async_runtime::spawn_blocking(imp::status).await.unwrap_or_default()
}

/// Settings → "Baixar modelo". Emits `voice-download` {file, received, total} as it goes.
#[tauri::command]
pub async fn voice_download_model(app: AppHandle) -> Result<(), String> {
    imp::download(app).await
}

/// Starts, restarts or stops the hotkey thread to match the settings. Cheap when nothing changed.
pub fn apply(app: &AppHandle, s: &Settings) {
    imp::apply(app, s)
}

fn emit_state(app: &AppHandle, state: &str, message: &str) {
    let _ = app.emit("voice-state", serde_json::json!({ "state": state, "message": message }));
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn start(_: &AppHandle) -> Result<(), String> {
        Err("Entrada de voz só existe no Windows.".into())
    }
    pub fn stop() {}
    pub fn status() -> VoiceStatus {
        VoiceStatus::default()
    }
    pub async fn download(_: AppHandle) -> Result<(), String> {
        Err("Entrada de voz só existe no Windows.".into())
    }
    pub fn apply(_: &AppHandle, _: &Settings) {}
}

#[cfg(windows)]
mod imp {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const RATE: usize = 16_000;
    const MAX_PHRASE: usize = 25 * RATE;
    const PAUSE: usize = RATE; // ~1 s of quiet ends the phrase
    const NO_SPEECH: usize = 30 * RATE; // mic is closed if nobody speaks for this long
    const QUIET: f32 = 0.012;
    const ENGINE_TIMEOUT: Duration = Duration::from_secs(30);

    struct File {
        name: &'static str,
        url: &'static str,
        sha256: &'static str,
        max: usize,
    }
    // Pinned to repository revisions; copied from the Lintel reference (whistle.rs).
    const FILES: [File; 2] = [
        File {
            name: "whistle.cact",
            url: "https://huggingface.co/Cactus-Compute/whistle/resolve/ca5287601bef25af26dcf2e1b2bdc0843a7c19e5/whistle.cact",
            sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
            max: 20 << 20,
        },
        File {
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
        crate::settings::local_dir().join("voice")
    }
    fn ready(dir: &Path) -> bool {
        FILES.iter().all(|f| std::fs::read(dir.join(f.name)).is_ok_and(|b| hex(Sha256::digest(&b)) == f.sha256))
    }

    // ── Hotkey thread ────────────────────────────────────────────────────────────

    static CAPTURING: AtomicBool = AtomicBool::new(false);
    static STOP: AtomicBool = AtomicBool::new(false);
    static THREAD: AtomicU32 = AtomicU32::new(0);
    static HOTKEY_ERROR: Mutex<String> = Mutex::new(String::new());
    /// What the running hotkey thread was started for.
    static RUNNING: Mutex<Option<(bool, String, String)>> = Mutex::new(None);

    pub fn apply(app: &AppHandle, s: &Settings) {
        let want = (s.voice_enabled, s.voice_hotkey.clone(), s.alert_hotkey.clone());
        let mut running = RUNNING.lock().unwrap();
        if running.as_ref() == Some(&want) {
            return;
        }
        quit_thread();
        STOP.store(true, Ordering::SeqCst); // a phrase in progress goes with its hotkey
        *HOTKEY_ERROR.lock().unwrap() = String::new();
        let voice = want.0.then(|| want.1.clone()).filter(|k| !k.is_empty());
        let alert = Some(want.2.clone()).filter(|k| !k.is_empty());
        *running = Some(want);
        if voice.is_none() && alert.is_none() {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || hotkey_loop(app, voice, alert));
    }

    fn quit_thread() {
        let id = THREAD.swap(0, Ordering::SeqCst);
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }

    fn hotkey_loop(app: AppHandle, voice: Option<String>, alert: Option<String>) {
        unsafe {
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE); // creates the queue
            let mut errors = Vec::new();
            let mut reg = |id: i32, label: &str, k: &Option<String>| {
                let Some(k) = k else { return };
                let Some((mods, vk)) = parse_hotkey(k) else {
                    return errors.push(format!("{label}: atalho inválido ({k})"));
                };
                if let Err(e) = RegisterHotKey(None, id, HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT, vk) {
                    errors.push(format!("{label}: não foi possível registrar {k} ({e})"));
                }
            };
            reg(1, "Voz", &voice);
            reg(2, "Ir ao alerta", &alert);
            let error = errors.join(" · ");
            *HOTKEY_ERROR.lock().unwrap() = error.clone();
            let _ = app.emit("voice-hotkey-error", error);
            THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                if msg.message == WM_HOTKEY {
                    match msg.wParam.0 {
                        1 if CAPTURING.load(Ordering::SeqCst) => stop(),
                        1 => {
                            if let Err(e) = start(&app) {
                                emit_state(&app, "error", &e);
                            }
                        }
                        2 => {
                            let _ = app.emit("go-to-alert", ());
                        }
                        _ => {}
                    }
                }
            }
            for id in [1, 2] {
                let _ = UnregisterHotKey(None, id);
            }
        }
    }

    pub fn status() -> VoiceStatus {
        VoiceStatus {
            ready: ready(&dir()),
            listening: CAPTURING.load(Ordering::SeqCst),
            hotkey_error: HOTKEY_ERROR.lock().unwrap().clone(),
        }
    }

    // ── Capture + transcription ──────────────────────────────────────────────────

    pub fn stop() {
        STOP.store(true, Ordering::SeqCst);
    }

    pub fn start(app: &AppHandle) -> Result<(), String> {
        if !crate::settings::load().voice_enabled {
            return Err("A entrada de voz está desligada nas Configurações.".into());
        }
        let d = dir();
        if !ready(&d) {
            return Err("Modelo de voz ausente: baixe em Configurações → Voz.".into());
        }
        if CAPTURING.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        STOP.store(false, Ordering::SeqCst);
        let app = app.clone();
        std::thread::spawn(move || {
            emit_state(&app, "listening", "");
            let result = record(&app).and_then(|pcm| match pcm {
                Some(pcm) => {
                    emit_state(&app, "transcribing", "");
                    transcribe(&d, &pcm).map(Some)
                }
                None => Ok(None),
            });
            CAPTURING.store(false, Ordering::SeqCst);
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
    fn record(app: &AppHandle) -> Result<Option<Vec<f32>>, String> {
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
            'run: while !STOP.load(Ordering::SeqCst) {
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
    fn transcribe(dir: &Path, pcm: &[f32]) -> Result<(String, String), String> {
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
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
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

    pub async fn download(app: AppHandle) -> Result<(), String> {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkeys() {
        assert_eq!(parse_hotkey("Ctrl+Alt+V"), Some((3, 'V' as u32)));
        assert_eq!(parse_hotkey("ctrl + shift + f5"), Some((6, 0x74)));
        assert_eq!(parse_hotkey("V"), None);
        assert_eq!(parse_hotkey("Ctrl+Alt"), None);
        assert_eq!(clean_hotkey("ctrl+alt+v", "X"), "Ctrl+Alt+V");
        assert_eq!(clean_hotkey("junk", "Ctrl+Alt+V"), "Ctrl+Alt+V");
        assert_eq!(clean_hotkey("", "Ctrl+Alt+V"), "");
    }
}
