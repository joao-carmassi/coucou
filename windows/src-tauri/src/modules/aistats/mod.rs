// Estatísticas de IA: token counters read from the local logs of Claude Code and Codex.
//
// Privacy: only numbers, model ids, day keys and project folder base names are kept, in
// %LOCALAPPDATA%\Coucou\aistats.json. No prompt, answer, tool input, full path or account data is stored or sent.
//
// Cost: nothing runs while the module is off, and nothing runs while it is on until the view asks for a
// refresh (no watcher, no timer). A refresh reads only the bytes added since the last one.

mod index;
mod parse;

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::core::host::{Module, ModuleCtx, ModuleHost};
use crate::core::platform;
use crate::core::settings::Settings;
use index::{Index, Kind};
use parse::{day_key, days_from_civil, Totals};

pub const PREFIXES: &[&str] = &["aistats_"];

const FILE: &str = "aistats.json";
const BUDGET: Duration = Duration::from_secs(2);
const SHOWN_DAYS: i64 = 30;

static INDEX: Mutex<Option<Index>> = Mutex::new(None);
static KEEP_DAYS: AtomicI64 = AtomicI64::new(90);

fn lock() -> std::sync::MutexGuard<'static, Option<Index>> {
    INDEX.lock().unwrap_or_else(|e| e.into_inner())
}

fn path() -> PathBuf {
    platform::local_dir().join(FILE)
}

fn load() -> Index {
    std::fs::read_to_string(path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Index { v: 1, ..Default::default() })
}

fn save(ix: &Index) -> std::io::Result<()> {
    let p = path();
    if let Some(dir) = p.parent() {
        platform::ensure_private_dir(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(ix).unwrap_or_default())?;
    std::fs::rename(tmp, p)
}

fn keep_days_of(s: &Settings) -> i64 {
    s.extra.get("aistatsKeepDays").and_then(|v| v.as_f64()).map_or(90, |n| (n as i64).clamp(1, 365))
}

// shortcut: the current UTC offset is applied to all history, so days read across a DST change can land one hour off; upgrade by storing UTC hours.
/// Local minus UTC in seconds, rounded to 15 min, from the clock Windows reports for the local zone.
fn local_offset() -> i64 {
    let t = platform::local_time();
    let local = days_from_civil(t.year.into(), t.month.into(), t.day.into()) * 86_400 + i64::from(t.hour * 3600 + t.minute * 60 + t.second);
    let utc = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    ((local - utc) as f64 / 900.0).round() as i64 * 900
}

fn roots() -> Vec<(PathBuf, Kind)> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = platform::home_dir();
    vec![
        (env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")).join("projects"), Kind::Claude),
        (env("CODEX_HOME").unwrap_or_else(|| home.join(".codex")).join("sessions"), Kind::Codex),
    ]
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    days: Vec<DayRow>,
    total: Totals,
    models: Vec<(String, Totals)>,
    projects: Vec<(String, u64)>,
    approx: bool,
    more: bool,
}

#[derive(Serialize, Debug)]
pub struct DayRow {
    day: String,
    tok: Totals,
}

/// The last `SHOWN_DAYS` local days ending `today` (a day number). Models: all, biggest first. Projects: top 5.
fn summarize(ix: &Index, today: i64, more: bool) -> Summary {
    let from = day_key(today - SHOWN_DAYS + 1);
    let mut s = Summary { days: vec![], total: Totals::default(), models: vec![], projects: vec![], approx: ix.approx, more };
    let mut models: std::collections::BTreeMap<&str, Totals> = Default::default();
    let mut projects: std::collections::BTreeMap<&str, u64> = Default::default();
    for (k, d) in ix.days.range(from..) {
        s.total.add(&d.tok);
        s.days.push(DayRow { day: k.clone(), tok: d.tok });
        d.by_model.iter().for_each(|(m, t)| models.entry(m).or_default().add(t));
        d.by_project.iter().for_each(|(p, n)| *projects.entry(p).or_insert(0) += n);
    }
    s.models = models.into_iter().map(|(m, t)| (m.to_string(), t)).collect();
    s.models.sort_by_key(|(_, t)| std::cmp::Reverse(t.sum()));
    s.projects = projects.into_iter().map(|(p, n)| (p.to_string(), n)).collect();
    s.projects.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    s.projects.truncate(5);
    s
}

fn today(off: i64) -> i64 {
    let utc = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    (utc + off).div_euclid(86_400)
}

pub struct AiStats;

impl Module for AiStats {
    fn id(&self) -> &'static str {
        "aistats"
    }

    fn start(&self, ctx: &ModuleCtx, s: &Settings) {
        KEEP_DAYS.store(keep_days_of(s), Ordering::Relaxed);
        ctx.on_stop(|| *lock() = None);
    }

    fn apply(&self, _ctx: &ModuleCtx, s: &Settings) {
        KEEP_DAYS.store(keep_days_of(s), Ordering::Relaxed);
    }
}

/// Scans for up to 2 s, saves, answers. The view calls it again while `more` is true.
#[tauri::command]
pub async fn aistats_refresh(host: State<'_, ModuleHost>) -> Result<Summary, String> {
    host.require("aistats")?;
    crate::core::host::blocking(|| {
        let off = local_offset();
        let mut g = lock();
        let ix = g.get_or_insert_with(load);
        let more = index::scan(ix, &roots(), BUDGET, off);
        index::prune(ix, &day_key(today(off) - KEEP_DAYS.load(Ordering::Relaxed) + 1));
        let _ = save(ix);
        summarize(ix, today(off), more)
    })
    .await
}

/// What is already indexed; reads no log.
#[tauri::command]
pub fn aistats_summary(host: State<ModuleHost>) -> Result<Summary, String> {
    host.require("aistats")?;
    let mut g = lock();
    Ok(summarize(g.get_or_insert_with(load), today(local_offset()), false))
}

/// Erases the index (works while the module is off). The logs of the tools are never touched.
#[tauri::command]
pub fn aistats_clear() {
    *lock() = None;
    let _ = std::fs::remove_file(path());
}

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(AiStats)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![aistats_refresh, aistats_summary, aistats_clear])
}

#[cfg(test)]
mod tests {
    use super::*;
    use index::Day;

    #[test]
    fn summary_window_and_ranking() {
        let mut ix = Index::default();
        let mut add = |k: &str, model: &str, project: &str, n: u64| {
            let d: &mut Day = ix.days.entry(k.into()).or_default();
            let t = Totals { output: n, ..Default::default() };
            d.tok.add(&t);
            d.by_model.entry(model.into()).or_default().add(&t);
            *d.by_project.entry(project.into()).or_insert(0) += n;
        };
        add("2026-10-17", "a", "p1", 5);
        add("2026-10-10", "b", "p2", 9);
        add("2026-09-01", "b", "p3", 100); // outside the 30 shown days
        let s = summarize(&ix, days_from_civil(2026, 10, 17), true);
        assert_eq!(s.days.len(), 2);
        assert_eq!(s.total.output, 14);
        assert_eq!(s.models[0].0, "b");
        assert_eq!(s.projects.iter().map(|p| p.0.as_str()).collect::<Vec<_>>(), ["p2", "p1"]);
        assert!(s.more && !s.approx);
    }

    #[test]
    fn keep_days_is_clamped() {
        let mut s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(keep_days_of(&s), 90);
        s.extra.insert("aistatsKeepDays".into(), 9999.into());
        assert_eq!(keep_days_of(&s), 365);
    }
}
