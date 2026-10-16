// The system media session (Windows "now playing"): one worker thread that blocks on a channel and wakes only when the
// OS reports a change (current session, track, play state, timeline). No polling, no timer.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use super::volume::app_label;
use crate::core::log;

/// What the island needs to draw the player. `art` is a small JPEG data URL (bounded, see `art_data_url`).
#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Media-session id of the player (an exe name or a packaged id): the volume control matches by it.
    pub app_id: String,
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_toggle: bool,
    /// Where the track was at `at` (already moved forward to `at` when playing). None when the player gives no timeline.
    pub position_ms: Option<u64>,
    /// None for streams without a length (most browsers): the view then hides the progress bar.
    pub duration_ms: Option<u64>,
    /// Unix ms the position is valid for.
    pub at: u64,
    pub art: Option<String>,
}

pub enum Msg {
    /// The current session itself changed (re-subscribe), then read.
    Session,
    /// Something about the current session changed: read.
    Changed,
    Control(Action),
    Quit,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Action {
    Toggle,
    Next,
    Prev,
}

pub fn parse_action(s: &str) -> Option<Action> {
    match s {
        "toggle" => Some(Action::Toggle),
        "next" => Some(Action::Next),
        "prev" => Some(Action::Prev),
        _ => None,
    }
}

/// Last snapshot sent (the view asks for it when it opens).
pub static LAST: Mutex<Option<Snapshot>> = Mutex::new(None);
/// Which worker owns LAST: a detached old worker (stuck past the stop grace) must not touch a restarted one's state.
pub static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const DRIFT_MS: i64 = 2_000;
const ART_PX: u32 = 96;
const ART_MAX_SOURCE: u64 = 4 * 1024 * 1024;
const ART_MAX_URL: usize = 48 * 1024;
const EPOCH_1601_TO_1970_MS: i64 = 11_644_473_600_000;

/// Position at `now` given the player's report: `pos_ms` as of `updated_unix_ms`, moving at `rate` while playing.
/// Clamped to the duration when there is one. A report from the future or with no time is taken as "now".
pub fn position_now(pos_ms: i64, updated_unix_ms: i64, now_ms: i64, playing: bool, rate: f64, duration_ms: Option<u64>) -> u64 {
    let mut pos = pos_ms.max(0);
    if playing && updated_unix_ms > 0 && now_ms > updated_unix_ms {
        pos += ((now_ms - updated_unix_ms) as f64 * if rate.is_finite() && rate > 0.0 { rate } else { 1.0 }) as i64;
    }
    let pos = pos.max(0) as u64;
    duration_ms.map_or(pos, |d| pos.min(d))
}

/// A length the player reports as end - start; zero, negative or absurd (> 24 h, live streams) means "unknown".
pub fn duration_of(start_ms: i64, end_ms: i64) -> Option<u64> {
    let d = end_ms - start_ms;
    (d > 0 && d <= 24 * 3_600_000).then_some(d as u64)
}

/// Is `next` worth sending after `prev`? Anything but the position counts; the position only when it left the line
/// the previous report drew (a seek), so a player that reports every second does not wake the island every second.
pub fn needs_emit(prev: Option<&Snapshot>, next: Option<&Snapshot>) -> bool {
    let (Some(p), Some(n)) = (prev, next) else { return prev.is_some() != next.is_some() };
    let strip = |s: &Snapshot| Snapshot { position_ms: None, at: 0, ..s.clone() };
    if strip(p) != strip(n) {
        return true;
    }
    match (p.position_ms, n.position_ms) {
        (Some(pp), Some(np)) => {
            let expected = pp as i64 + if p.playing { n.at as i64 - p.at as i64 } else { 0 };
            (np as i64 - expected).abs() > DRIFT_MS
        }
        (a, b) => a != b,
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Cover bytes (any format `image` reads) to a 96 px JPEG data URL; None when it cannot be read or stays over 48 KiB.
pub fn art_data_url(bytes: &[u8]) -> Option<String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let small = img.thumbnail(ART_PX, ART_PX).to_rgb8();
    let mut jpg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 80).encode_image(&small).ok()?;
    let url = format!("data:image/jpeg;base64,{}", base64(&jpg));
    (url.len() <= ART_MAX_URL).then_some(url)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_art(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > ART_MAX_SOURCE {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    art_data_url(&buf)
}

/// Reads the session; `art` is the cover already known for this track (an empty cover is asked for again).
fn read(s: &Session, cached: &mut (String, bool, Option<String>)) -> Option<Snapshot> {
    let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let text = |r: windows::core::Result<windows::core::HSTRING>| r.map(|h| h.to_string()).unwrap_or_default();
    let (title, artist, album) = (text(props.Title()), text(props.Artist()), text(props.AlbumTitle()));
    let app_id = text(s.SourceAppUserModelId());
    let info = s.GetPlaybackInfo().ok()?;
    let playing = info.PlaybackStatus().ok()? == Status::Playing;
    let controls = info.Controls().ok();
    let flag = |f: Option<windows::core::Result<bool>>| f.and_then(|r| r.ok()).unwrap_or(false);
    let rate = info.PlaybackRate().ok().and_then(|r| r.Value().ok()).unwrap_or(1.0);
    let at = now_ms();
    let (mut position_ms, mut duration_ms) = (None, None);
    if let Ok(tl) = s.GetTimelineProperties() {
        let t = |r: windows::core::Result<windows::Foundation::TimeSpan>| r.map(|v| v.Duration / 10_000).unwrap_or(0);
        duration_ms = duration_of(t(tl.StartTime()), t(tl.EndTime()));
        let updated = tl.LastUpdatedTime().map(|d| d.UniversalTime / 10_000 - EPOCH_1601_TO_1970_MS).unwrap_or(0);
        if duration_ms.is_some() {
            position_ms = Some(position_now(t(tl.Position()) - t(tl.StartTime()), updated, at, playing, rate, duration_ms));
        }
    }
    let key = format!("{app_id}\u{1}{title}\u{1}{artist}\u{1}{album}");
    if cached.0 != key || !cached.1 {
        // A miss is cached too (cached.1 = looked up), so a coverless track is not re-read on every event.
        *cached = (key, true, read_art(&props));
    }
    Some(Snapshot {
        app: app_label(&app_id),
        app_id,
        title,
        artist,
        album,
        playing,
        can_prev: flag(controls.as_ref().map(|c| c.IsPreviousEnabled())),
        can_next: flag(controls.as_ref().map(|c| c.IsNextEnabled())),
        can_toggle: flag(controls.as_ref().map(|c| c.IsPlayPauseToggleEnabled())),
        position_ms,
        duration_ms,
        at: at as u64,
        art: cached.2.clone(),
    })
}

/// Event tokens of the session we are subscribed to.
struct Subscription {
    session: Session,
    tokens: [i64; 3],
    count: usize,
}

impl Subscription {
    fn new(session: Session, tx: &Sender<Msg>) -> windows::core::Result<Self> {
        let ping = |tx: &Sender<Msg>| {
            let tx = tx.clone();
            move || {
                let _ = tx.send(Msg::Changed);
            }
        };
        let (a, b, c) = (ping(tx), ping(tx), ping(tx));
        // Built one by one: if a later registration fails, dropping `sub` removes the earlier ones.
        let mut sub = Subscription { session: session.clone(), tokens: [0; 3], count: 0 };
        sub.tokens[0] = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            a();
            Ok(())
        }))?;
        sub.count = 1;
        sub.tokens[1] = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            b();
            Ok(())
        }))?;
        sub.count = 2;
        sub.tokens[2] = session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
            c();
            Ok(())
        }))?;
        sub.count = 3;
        Ok(sub)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if self.count > 0 {
            let _ = self.session.RemoveMediaPropertiesChanged(self.tokens[0]);
        }
        if self.count > 1 {
            let _ = self.session.RemovePlaybackInfoChanged(self.tokens[1]);
        }
        if self.count > 2 {
            let _ = self.session.RemoveTimelinePropertiesChanged(self.tokens[2]);
        }
    }
}

fn publish(app: &AppHandle, snap: Option<Snapshot>, gen: u64) {
    let mut last = LAST.lock().unwrap();
    if GEN.load(std::sync::atomic::Ordering::SeqCst) != gen {
        return;
    }
    if needs_emit(last.as_ref(), snap.as_ref()) {
        let _ = app.emit("nowplaying-state", &snap);
        *last = snap;
    }
}

/// The worker. Returns when `Quit` arrives (or the channel closes). Event handlers are removed before it returns.
pub fn run(app: &AppHandle, tx: Sender<Msg>, rx: Receiver<Msg>, gen: u64) {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let mgr = match Manager::RequestAsync().and_then(|op| op.get()) {
        Ok(m) => m,
        Err(e) => {
            log::line(format!("nowplaying: media session manager unavailable: {e}"));
            return;
        }
    };
    let tx2 = tx.clone();
    let token = mgr.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        let _ = tx2.send(Msg::Session);
        Ok(())
    }));
    let mut sub: Option<Subscription> = None;
    let mut cached = (String::new(), false, None);
    let mut pending = Some(Msg::Session);
    loop {
        let msg = match pending.take() {
            Some(m) => m,
            None => match rx.recv() {
                Ok(m) => m,
                Err(_) => break,
            },
        };
        let mut resubscribe = matches!(msg, Msg::Session);
        match msg {
            Msg::Quit => break,
            Msg::Control(a) => {
                if let Some(s) = sub.as_ref().map(|s| &s.session) {
                    let _ = match a {
                        Action::Toggle => s.TryTogglePlayPauseAsync(),
                        Action::Next => s.TrySkipNextAsync(),
                        Action::Prev => s.TrySkipPreviousAsync(),
                    };
                }
                continue;
            }
            Msg::Session | Msg::Changed => {}
        }
        // Several events arrive together for one track change: read once after they settle.
        loop {
            match rx.recv_timeout(Duration::from_millis(80)) {
                Ok(Msg::Session) => resubscribe = true,
                Ok(Msg::Changed) => {}
                Ok(other) => {
                    pending = Some(other);
                    break;
                }
                Err(_) => break,
            }
        }
        if resubscribe || sub.is_none() {
            drop(sub.take()); // removes the old handlers first
            sub = mgr.GetCurrentSession().ok().and_then(|s| Subscription::new(s, &tx).ok());
        }
        let snap = sub.as_ref().and_then(|s| read(&s.session, &mut cached));
        publish(app, snap, gen);
    }
    drop(sub);
    if let Ok(t) = token {
        let _ = mgr.RemoveCurrentSessionChanged(t);
    }
    let mut last = LAST.lock().unwrap();
    if GEN.load(std::sync::atomic::Ordering::SeqCst) == gen {
        *last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(pos: Option<u64>, at: u64, playing: bool) -> Snapshot {
        Snapshot { title: "t".into(), playing, position_ms: pos, duration_ms: Some(200_000), at, ..Default::default() }
    }

    #[test]
    fn position_moves_forward_only_while_playing_and_clamps() {
        assert_eq!(position_now(10_000, 1_000, 3_000, true, 1.0, Some(100_000)), 12_000);
        assert_eq!(position_now(10_000, 1_000, 3_000, false, 1.0, Some(100_000)), 10_000);
        assert_eq!(position_now(10_000, 1_000, 3_000, true, 2.0, None), 14_000);
        assert_eq!(position_now(99_000, 1_000, 9_000, true, 1.0, Some(100_000)), 100_000);
        assert_eq!(position_now(-5, 0, 3_000, true, 1.0, None), 0);
        assert_eq!(position_now(10_000, 5_000, 3_000, true, 1.0, None), 10_000); // report from the future
        assert_eq!(position_now(10_000, 1_000, 3_000, true, f64::NAN, None), 12_000);
    }

    #[test]
    fn duration_unknown_for_streams() {
        assert_eq!(duration_of(0, 215_000), Some(215_000));
        assert_eq!(duration_of(0, 0), None);
        assert_eq!(duration_of(5, 1), None);
        assert_eq!(duration_of(0, 48 * 3_600_000), None);
    }

    #[test]
    fn emit_only_on_real_changes() {
        let a = snap(Some(10_000), 1_000, true);
        assert!(needs_emit(None, Some(&a)));
        assert!(needs_emit(Some(&a), None));
        assert!(!needs_emit(None, None));
        // The player repeats its timeline a second later, on the line: nothing to say.
        assert!(!needs_emit(Some(&a), Some(&snap(Some(11_000), 2_000, true))));
        // A seek.
        assert!(needs_emit(Some(&a), Some(&snap(Some(90_000), 2_000, true))));
        // Pause, and a title change.
        assert!(needs_emit(Some(&a), Some(&snap(Some(11_000), 2_000, false))));
        let mut b = snap(Some(11_000), 2_000, true);
        b.title = "other".into();
        assert!(needs_emit(Some(&a), Some(&b)));
        // Paused: position must not move; a drift from the paused spot is a seek.
        let p = snap(Some(10_000), 1_000, false);
        assert!(!needs_emit(Some(&p), Some(&snap(Some(10_000), 9_000, false))));
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn art_is_small_and_bounded() {
        // A 600x600 PNG becomes a 96 px JPEG data URL under the cap.
        let img = image::RgbImage::from_fn(600, 600, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let url = art_data_url(&png).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        assert!(url.len() <= ART_MAX_URL);
        assert!(art_data_url(b"not an image").is_none());
    }

    #[test]
    fn actions_parse() {
        assert_eq!(parse_action("toggle"), Some(Action::Toggle));
        assert_eq!(parse_action("next"), Some(Action::Next));
        assert_eq!(parse_action("prev"), Some(Action::Prev));
        assert_eq!(parse_action("rm -rf"), None);
    }
}
