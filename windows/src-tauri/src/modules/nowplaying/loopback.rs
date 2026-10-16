// WASAPI loopback of the default RENDER device (what the speakers play). No microphone is opened.
// Runs only between nowplaying_capture(true) and (false); samples live in a 1024-sample window, are analysed and dropped.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

use super::analyze::{loudness, mono_from_bytes, Analyzer, SampleFmt, BANDS, FFT_N};
use crate::core::log;

const POLL: Duration = Duration::from_millis(20);
/// Events per second are capped here (the view and the Mochi both look fine at 30).
const EMIT_EVERY: Duration = Duration::from_millis(33);

#[derive(Serialize, Clone)]
struct Bands {
    bands: Vec<f32>,
    level: f32,
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// Blocks until `stop` or `off` is set. Reopens the device after a failure (default device changed).
pub fn run(app: &AppHandle, stop: &AtomicBool, off: &AtomicBool) {
    let done = || stop.load(Ordering::SeqCst) || off.load(Ordering::SeqCst);
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let mut wait = Duration::from_secs(1);
    while !done() {
        let started = Instant::now();
        match unsafe { capture(app, &done) } {
            // Ended by itself (the default device changed): reopen at once.
            Ok(()) => wait = Duration::from_secs(1),
            Err(e) => {
                // Log the first failure of a run only; back off up to 30 s while it keeps failing.
                if started.elapsed() > Duration::from_secs(10) {
                    wait = Duration::from_secs(1);
                }
                if wait == Duration::from_secs(1) {
                    log::line(format!("nowplaying: loopback stopped: {e}"));
                }
                let until = Instant::now() + wait;
                while !done() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(100));
                }
                wait = (wait * 2).min(Duration::from_secs(30));
            }
        }
    }
    if com {
        unsafe { CoUninitialize() };
    }
}

/// Endpoint id as a String; the COM string is freed.
unsafe fn id_of(d: &IMMDevice) -> windows::core::Result<String> {
    let p = d.GetId()?;
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const _));
    Ok(s)
}

unsafe fn capture(app: &AppHandle, done: &dyn Fn() -> bool) -> windows::core::Result<()> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let device_id = id_of(&device)?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
    let fmt = client.GetMixFormat()?;
    let (rate, channels, bits) = ((*fmt).nSamplesPerSec, (*fmt).nChannels as usize, (*fmt).wBitsPerSample);
    let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None);
    CoTaskMemFree(Some(fmt as *const _));
    init?;
    let sample = match bits {
        32 => SampleFmt::F32,
        16 => SampleFmt::I16,
        _ => return Err(windows::core::Error::new(windows::core::HRESULT(-1), format!("unsupported mix format ({bits} bits)"))),
    };
    let cap: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    let mut analyzer = Analyzer::new(rate);
    let mut window: VecDeque<f32> = VecDeque::with_capacity(FFT_N * 2);
    let mut last_emit = Instant::now();
    let mut polls = 0u32;
    let mut fresh = false; // new samples since the last emit (no packets while nothing plays)
    let result = (|| -> windows::core::Result<()> {
        while !done() {
            std::thread::sleep(POLL);
            polls += 1;
            // Once a second: did the default output device change? Then end, and `run` reopens on the new one.
            if polls % 50 == 0 {
                let now = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).and_then(|d| id_of(&d));
                if now.is_ok_and(|n| n != device_id) {
                    return Ok(());
                }
            }
            while cap.GetNextPacketSize()? > 0 {
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    window.extend(std::iter::repeat_n(0.0, frames as usize));
                } else {
                    let bytes = std::slice::from_raw_parts(data, frames as usize * (bits as usize / 8) * channels);
                    window.extend(mono_from_bytes(bytes, channels, sample));
                }
                cap.ReleaseBuffer(frames)?;
                fresh = true;
                while window.len() > FFT_N {
                    window.pop_front();
                }
            }
            if fresh && window.len() == FFT_N && last_emit.elapsed() >= EMIT_EVERY {
                last_emit = Instant::now();
                fresh = false;
                let samples: Vec<f32> = window.iter().copied().collect();
                let bands = analyzer.analyze(&samples);
                debug_assert_eq!(bands.len(), BANDS);
                let payload = Bands { level: round2(loudness(&bands)), bands: bands.iter().map(|b| round2(*b)).collect() };
                let _ = app.emit("nowplaying-bands", payload);
            }
        }
        Ok(())
    })();
    let _ = client.Stop();
    result
}
