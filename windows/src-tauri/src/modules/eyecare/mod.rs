// Pausas: screen time per foreground exe. Rust side of the module.
//
// Privacy: only executable file names (never window titles, URLs or paths) and whole seconds per local day,
// kept in %LOCALAPPDATA%\Coucou\eyecare.json for `eyecareKeepDays` days. Nothing leaves the machine.
// Break rounds are two counters per local day plus the time of the last break, in eyecare-breaks.json, same retention.
//
// Idle: no input for IDLE_GRACE_MS (5 min) stops the count; a full-screen/game/call ("quiet") counts as present.
// Cost: one module thread that wakes once a minute (a channel recv_timeout, woken at once by stop) and cuts the
// open segment, so idle is seen close to when it happens. The shared foreground hook (core/presence) also calls
// `on_fg` at every foreground change, and the frontend calls `eyecare_checkpoint` at each reminder.
// A segment longer than SEG_CAP_SECS can only span a sleep/hibernate, which is therefore not credited.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

use tauri::AppHandle;

use crate::core::host::{Module, ModuleCtx};
use crate::core::platform;
use crate::core::presence::{self, Foreground};
use crate::core::settings::Settings;

pub const PREFIXES: &[&str] = &["eyecare_"];

const FILE: &str = "eyecare.json";
const BREAKS_FILE: &str = "eyecare-breaks.json";
/// No input for this long = away: that whole stretch is not counted.
const IDLE_GRACE_MS: u64 = 5 * 60_000;
/// Segments are cut every CUT_EVERY_SECS, so more than this means the machine slept.
const SEG_CAP_SECS: u64 = 180;
const CUT_EVERY_SECS: u64 = 60;
/// Disk writes at most this often from the foreground hook (checkpoints and stop always write).
const WRITE_EVERY_SECS: u64 = 60;
const DEFAULT_EXCLUDED: &[&str] = &["lockapp.exe"];

type Days = BTreeMap<String, BTreeMap<String, u64>>;

/// Reminder rounds per local day as `[due, taken]`, and the unix ms of the last break taken (0 = none).
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Breaks {
    days: BTreeMap<String, [u32; 2]>,
    last: u64,
}

impl Breaks {
    fn record(&mut self, day: String, today: i64, keep: i64, taken: bool, now_ms: u64) {
        let d = self.days.entry(day).or_default();
        d[0] = d[0].saturating_add(1);
        if taken {
            d[1] = d[1].saturating_add(1);
            self.last = now_ms;
        }
        prune(&mut self.days, today, keep);
    }
}

struct Cfg {
    excluded: Vec<String>,
    keep_days: i64,
}

struct Acc {
    days: Days,
    cur: Option<(String, Instant)>,
    cfg: Cfg,
    breaks: Breaks,
    dirty: bool,
    written: Instant,
}

static ACC: Mutex<Option<Acc>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<Acc>> {
    ACC.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Pure logic ────────────────────────────────────────────────────────────────

/// Seconds to credit for a segment of `elapsed_ms` when the user has been idle `idle_ms`: from the grace on, the
/// whole idle stretch is taken off (below it, nothing); capped at SEG_CAP_SECS.
fn credit(elapsed_ms: u64, idle_ms: u64) -> u64 {
    let lost = if idle_ms >= IDLE_GRACE_MS { idle_ms.min(elapsed_ms) } else { 0 };
    ((elapsed_ms - lost) / 1000).min(SEG_CAP_SECS)
}

/// Days since 1970-01-01 of a civil date (proleptic Gregorian).
fn day_number(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "YYYY-MM-DD" -> day number.
fn parse_day(k: &str) -> Option<i64> {
    let mut it = k.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    ((1..=12).contains(&m) && (1..=31).contains(&d) && it.next().is_none()).then(|| day_number(y, m, d))
}

/// Drops days older than `keep` days counting `today` (and keys that are not dates).
fn prune<V>(days: &mut BTreeMap<String, V>, today: i64, keep: i64) {
    days.retain(|k, _| parse_day(k).is_some_and(|n| n > today - keep && n <= today + 1));
}

fn is_excluded(exe: &str, excluded: &[String]) -> bool {
    exe.is_empty() || excluded.iter().any(|e| e == exe)
}

fn today_key() -> (String, i64) {
    let t = platform::local_time();
    (format!("{:04}-{:02}-{:02}", t.year, t.month, t.day), day_number(t.year.into(), t.month.into(), t.day.into()))
}

fn cfg_of(s: &Settings) -> Cfg {
    let excluded = match s.extra.get("eyecareExcluded").and_then(|v| v.as_array()) {
        Some(a) => a.iter().filter_map(|v| v.as_str()).map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty()).collect(),
        None => DEFAULT_EXCLUDED.iter().map(|e| e.to_string()).collect(),
    };
    let keep_days = s.extra.get("eyecareKeepDays").and_then(|v| v.as_f64()).map_or(30, |n| (n as i64).clamp(1, 90));
    Cfg { excluded, keep_days }
}

impl Acc {
    /// Credits the open segment up to `now` and starts a new one for `next` (None = nothing is counted).
    fn switch(&mut self, now: Instant, idle_ms: u64, next: Option<String>) {
        if let Some((exe, since)) = self.cur.take() {
            let secs = credit(now.duration_since(since).as_millis() as u64, idle_ms);
            if secs > 0 && !is_excluded(&exe, &self.cfg.excluded) {
                let (day, n) = today_key();
                *self.days.entry(day).or_default().entry(exe).or_insert(0) += secs;
                prune(&mut self.days, n, self.cfg.keep_days);
                self.dirty = true;
            }
        }
        self.cur = next.filter(|e| !is_excluded(e, &self.cfg.excluded)).map(|e| (e, now));
    }

    fn flush(&mut self) {
        if self.dirty {
            self.dirty = false;
            let _ = write(&path(), &self.days);
        }
        self.written = Instant::now();
    }
}

// ── Disk ──────────────────────────────────────────────────────────────────────

fn path() -> std::path::PathBuf {
    platform::local_dir().join(FILE)
}

fn breaks_path() -> std::path::PathBuf {
    platform::local_dir().join(BREAKS_FILE)
}

fn read<T: serde::de::DeserializeOwned + Default>(p: &std::path::Path) -> T {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write<T: serde::Serialize>(p: &std::path::Path, v: &T) -> std::io::Result<()> {
    if let Some(dir) = p.parent() {
        platform::ensure_private_dir(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(v).unwrap_or_default())?;
    std::fs::rename(tmp, p)
}

/// Idle ms to take off a segment: 0 while the user is "quiet" (full-screen video, game, presentation, call),
/// who watches without touching the input.
fn away_ms() -> u64 {
    let idle = presence::user_idle_ms();
    if idle >= IDLE_GRACE_MS && presence::now().quiet { 0 } else { idle }
}

/// Cuts the open segment on the current exe; flushes when `force` or the write is due.
fn cut(force: bool) {
    let idle = away_ms();
    if let Some(acc) = lock().as_mut() {
        let cur = acc.cur.as_ref().map(|c| c.0.clone());
        acc.switch(Instant::now(), idle, cur);
        if force || acc.written.elapsed().as_secs() >= WRITE_EVERY_SECS {
            acc.flush();
        }
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ── Module ────────────────────────────────────────────────────────────────────

pub struct EyecareModule;

/// Runs on the shared hook thread: short, no module stop, no unsubscribe.
fn on_fg(_app: &AppHandle, fg: &Foreground) {
    let mut g = lock();
    let Some(acc) = g.as_mut() else { return };
    acc.switch(Instant::now(), away_ms(), Some(fg.exe.clone()));
    if acc.dirty && acc.written.elapsed().as_secs() >= WRITE_EVERY_SECS {
        acc.flush();
    }
}

/// Erases the counters of excluded apps; marks the data dirty when something went.
fn forget_excluded(acc: &mut Acc) {
    let ex = acc.cfg.excluded.clone();
    for d in acc.days.values_mut() {
        let n = d.len();
        d.retain(|exe, _| !is_excluded(exe, &ex));
        acc.dirty |= d.len() != n;
    }
}

impl Module for EyecareModule {
    fn id(&self) -> &'static str {
        "eyecare"
    }

    fn start(&self, ctx: &ModuleCtx, s: &Settings) {
        let cfg = cfg_of(s);
        let today = today_key().1;
        let mut days: Days = read(&path());
        prune(&mut days, today, cfg.keep_days);
        let mut breaks: Breaks = read(&breaks_path());
        prune(&mut breaks.days, today, cfg.keep_days);
        let mut acc = Acc { days, cur: None, cfg, breaks, dirty: false, written: Instant::now() };
        forget_excluded(&mut acc);
        acc.flush();
        acc.switch(Instant::now(), 0, Some(presence::foreground_now().exe));
        *lock() = Some(acc);
        presence::on_foreground(ctx, on_fg);
        let (wake, rx) = std::sync::mpsc::channel::<()>();
        ctx.spawn(move |stop| {
            // Timeout = next cut; a message or a dropped sender = stop.
            while matches!(rx.recv_timeout(std::time::Duration::from_secs(CUT_EVERY_SECS)), Err(std::sync::mpsc::RecvTimeoutError::Timeout))
                && !stop.load(std::sync::atomic::Ordering::Relaxed)
            {
                cut(false);
            }
        });
        // Registered after the hook's own stopper, so it runs first (stoppers run in reverse).
        ctx.on_stop(move || {
            let _ = wake.send(());
            if let Some(mut acc) = lock().take() {
                acc.switch(Instant::now(), away_ms(), None);
                acc.dirty = true;
                acc.flush();
            }
        });
    }

    fn apply(&self, _ctx: &ModuleCtx, s: &Settings) {
        if let Some(acc) = lock().as_mut() {
            acc.cfg = cfg_of(s);
            // A newly excluded app is forgotten, not just ignored from now on.
            forget_excluded(acc);
            let cur = acc.cur.take().map(|c| c.0);
            acc.cur = cur.filter(|e| !is_excluded(e, &acc.cfg.excluded)).map(|e| (e, Instant::now()));
            acc.flush();
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// ms since the last keyboard or mouse input.
    idle: u64,
    /// Full-screen app, presentation, call or quiet hours: do not interrupt.
    quiet: bool,
}

/// Cuts the open segment (idle time removed) and answers the idle ms and whether the user is "quiet".
#[tauri::command]
pub fn eyecare_checkpoint() -> Checkpoint {
    cut(true);
    Checkpoint { idle: presence::user_idle_ms(), quiet: presence::now().quiet }
}

/// day -> exe -> seconds, after a checkpoint. Empty while the module is off.
#[tauri::command]
pub fn eyecare_usage() -> Days {
    eyecare_checkpoint();
    lock().as_ref().map(|a| a.days.clone()).unwrap_or_default()
}

/// One reminder round came due (reminders on, kinds enabled, not paused); `taken` = the user was already away.
#[tauri::command]
pub fn eyecare_break(taken: bool) {
    if let Some(acc) = lock().as_mut() {
        let (day, n) = today_key();
        acc.breaks.record(day, n, acc.cfg.keep_days, taken, unix_ms());
        let _ = write(&breaks_path(), &acc.breaks);
    }
}

/// The break rounds kept. Empty while the module is off.
#[tauri::command]
pub fn eyecare_breaks() -> Breaks {
    lock().as_ref().map(|a| a.breaks.clone()).unwrap_or_default()
}

/// "Apagar dados": forgets everything, memory and files.
#[tauri::command]
pub fn eyecare_clear() {
    if let Some(acc) = lock().as_mut() {
        acc.days.clear();
        acc.breaks = Breaks::default();
        acc.dirty = false;
        acc.cur = acc.cur.take().map(|(e, _)| (e, Instant::now()));
    }
    let _ = std::fs::remove_file(path());
    let _ = std::fs::remove_file(breaks_path());
}

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(EyecareModule)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![eyecare_checkpoint, eyecare_usage, eyecare_break, eyecare_breaks, eyecare_clear])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn acc(excluded: &[&str]) -> Acc {
        let cfg = Cfg { excluded: excluded.iter().map(|e| e.to_string()).collect(), keep_days: 30 };
        Acc { days: Days::new(), cur: None, cfg, breaks: Breaks::default(), dirty: false, written: Instant::now() }
    }

    #[test]
    fn credit_removes_idle_past_grace_and_caps() {
        assert_eq!(credit(120_000, 0), 120);
        assert_eq!(credit(60_000, 299_000), 60); // below the grace nothing is taken off
        assert_eq!(credit(60_000, 300_000), 0); // 5 min idle: the segment was idle
        assert_eq!(credit(170_000, 100_000_000), 0);
        assert_eq!(credit(600_000, 450_000), 150); // idle for the last 450 s of 600 s
        assert_eq!(credit(600_000, 9_999_999), 0);
        assert_eq!(credit(10 * 3600 * 1000, 0), SEG_CAP_SECS);
    }

    #[test]
    fn prune_keeps_a_rolling_window() {
        let today = day_number(2026, 3, 1);
        let mut d = Days::new();
        for k in ["2026-03-01", "2026-02-10", "2026-01-31", "2026-01-30", "junk"] {
            d.insert(k.into(), BTreeMap::new());
        }
        prune(&mut d, today, 30); // 30 days counting today: back to 2026-01-31
        assert_eq!(d.keys().map(String::as_str).collect::<Vec<_>>(), ["2026-01-31", "2026-02-10", "2026-03-01"]);
        assert_eq!(day_number(1970, 1, 1), 0);
        assert_eq!(day_number(2024, 3, 1) - day_number(2024, 2, 28), 2); // leap year
    }

    #[test]
    fn switch_credits_the_previous_exe_only() {
        let mut a = acc(&["lockapp.exe"]);
        let t0 = Instant::now();
        a.switch(t0, 0, Some("code.exe".into()));
        a.switch(t0 + Duration::from_secs(90), 0, Some("lockapp.exe".into()));
        assert!(a.cur.is_none(), "an excluded app is not tracked");
        assert_eq!(a.days.values().next().unwrap()["code.exe"], 90);
        a.switch(t0 + Duration::from_secs(200), 0, Some("code.exe".into()));
        assert!(a.days.values().all(|d| !d.contains_key("lockapp.exe")));
    }

    #[test]
    fn idle_segment_credits_nothing() {
        let mut a = acc(&[]);
        let t0 = Instant::now();
        a.switch(t0, 0, Some("code.exe".into()));
        a.switch(t0 + Duration::from_secs(600), 3_600_000, Some("code.exe".into()));
        assert!(a.days.is_empty());
    }

    #[test]
    fn breaks_count_rounds_and_keep_the_window() {
        let mut b = Breaks::default();
        let today = day_number(2026, 3, 10);
        b.days.insert("2026-01-01".into(), [3, 1]);
        b.record("2026-03-10".into(), today, 30, false, 5);
        b.record("2026-03-10".into(), today, 30, true, 7);
        assert_eq!(b.days.len(), 1, "old day pruned");
        assert_eq!(b.days["2026-03-10"], [2, 1]);
        assert_eq!(b.last, 7);
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"days":{"2026-03-10":[2,1]},"last":7}"#);
    }

    #[test]
    fn config_defaults_and_clamps() {
        let mut s = Settings::default();
        assert_eq!(cfg_of(&s).excluded, ["lockapp.exe"]);
        assert_eq!(cfg_of(&s).keep_days, 30);
        s.extra.insert("eyecareExcluded".into(), serde_json::json!([" Chrome.EXE ", ""]));
        s.extra.insert("eyecareKeepDays".into(), serde_json::json!(500));
        let c = cfg_of(&s);
        assert_eq!(c.excluded, ["chrome.exe"]);
        assert_eq!(c.keep_days, 90);
    }
}
