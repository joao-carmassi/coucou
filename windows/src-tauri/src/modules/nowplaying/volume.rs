// Per-app volume: the Windows audio sessions of the default render device whose process matches the player.
// The player is known by its media-session id (an exe name such as "Spotify.exe" or a packaged id such as
// "Microsoft.ZuneMusic_8wekyb3d8bbwe!App"), the audio session by a process id, so the match is by NAME and fuzzy.

use windows::core::Interface;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

/// Lowercase last name of an app id: "Spotify.exe" -> "spotify"; "Microsoft.ZuneMusic_8we!Microsoft.ZuneMusic" -> "zunemusic".
/// A packaged id ending in the generic "App" uses the package name before "!" instead.
pub fn app_key(id: &str) -> String {
    let mut parts = id.rsplit('!');
    let last = parts.next().unwrap_or(id);
    let after = match parts.next() {
        Some(pkg) if last.eq_ignore_ascii_case("app") => pkg,
        _ => last,
    };
    let before = after.split('_').next().unwrap_or(after);
    let lower = before.to_lowercase();
    let lower = lower.strip_suffix(".exe").unwrap_or(&lower);
    lower.rsplit('.').next().unwrap_or(lower).to_string()
}

/// Display name: the key with a capital ("spotify" -> "Spotify").
pub fn app_label(id: &str) -> String {
    let k = app_key(id);
    let mut c = k.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// Player ids whose audio runs under another exe name.
const ALIASES: &[(&str, &str)] = &[("zunemusic", "ui")];

/// Does the audio process `exe` (file name, any case) belong to the player `id`?
/// Equal keys, or a pair in ALIASES (a containment rule would let "msedge" move "msedgewebview2").
pub fn exe_matches(id: &str, exe: &str) -> bool {
    let (k, e) = (app_key(id), app_key(exe));
    if k.is_empty() || e.is_empty() {
        return false;
    }
    k == e || ALIASES.iter().any(|(a, b)| (k == *a && e == *b) || (k == *b && e == *a))
}

fn clamp01(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn exe_of(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_string)
    }
}

/// Volume controls of every audio session whose process matches `id`.
fn controls(id: &str) -> windows::core::Result<Vec<ISimpleAudioVolume>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // already initialised on a reused thread is fine
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let mgr: IAudioSessionManager2 = dev.Activate(CLSCTX_ALL, None)?;
        let list = mgr.GetSessionEnumerator()?;
        let mut out = Vec::new();
        for i in 0..list.GetCount()? {
            let Ok(ctl) = list.GetSession(i) else { continue };
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let pid = ctl2.GetProcessId().unwrap_or(0);
            if pid == 0 {
                continue; // the system sounds session
            }
            if exe_of(pid).is_some_and(|e| exe_matches(id, &e)) {
                if let Ok(v) = ctl.cast::<ISimpleAudioVolume>() {
                    out.push(v);
                }
            }
        }
        Ok(out)
    }
}

/// 0..1 of the first matching session; None when the player has no audio session (nothing is sounding).
pub fn get(id: &str) -> Result<Option<f32>, String> {
    let v = controls(id).map_err(|e| e.to_string())?;
    Ok(v.first().and_then(|c| unsafe { c.GetMasterVolume().ok() }).map(clamp01))
}

/// Sets every matching session; returns how many were changed.
pub fn set(id: &str, level: f32) -> Result<usize, String> {
    let level = clamp01(level);
    let v = controls(id).map_err(|e| e.to_string())?;
    Ok(v.iter().filter(|c| unsafe { c.SetMasterVolume(level, std::ptr::null()).is_ok() }).count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_from_exe_and_packaged_ids() {
        assert_eq!(app_key("Spotify.exe"), "spotify");
        assert_eq!(app_key("chrome.exe"), "chrome");
        assert_eq!(app_key("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "zunemusic");
        assert_eq!(app_key("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "spotify");
        assert_eq!(app_label("spotify.exe"), "Spotify");
        assert_eq!(app_label(""), "");
    }

    #[test]
    fn matching_is_by_name_and_fuzzy() {
        assert!(exe_matches("Spotify.exe", "Spotify.exe"));
        assert!(exe_matches("Spotify.exe", "SPOTIFY.EXE"));
        assert!(exe_matches("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "Spotify.exe"));
        assert!(exe_matches("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", "ZuneMusic.exe"));
        assert!(exe_matches("msedge.exe", "msedge.exe"));
        assert!(!exe_matches("Spotify.exe", "chrome.exe"));
        assert!(!exe_matches("", "chrome.exe"));
        assert!(!exe_matches("vlc.exe", "vlcx.exe"));
        assert!(!exe_matches("msedge.exe", "msedgewebview2.exe"));
        assert_eq!(app_key("Some.Pkg_abc!App"), "pkg");
        assert_eq!(app_label("Some.Pkg_abc!App"), "Pkg");
    }

    #[test]
    fn volume_is_clamped() {
        assert_eq!(clamp01(2.0), 1.0);
        assert_eq!(clamp01(-1.0), 0.0);
        assert_eq!(clamp01(f32::NAN), 0.0);
    }
}
