// Codex plan limits, read from the rollout files Codex writes under its sessions folder. Local only, no network.
// Only the `rate_limits` counters of `token_count` lines are read; `session_meta` (first line, holds an id) is never parsed.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

/// Same shape as `UsageWindow` in modules/agents/api.ts (`resetsAt` in unix ms).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub label: String,
    pub used_pct: Option<f64>,
    pub resets_at: Option<u64>,
}

/// Same shape as `AgentUsage` in modules/agents/api.ts.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub agent: String,
    pub windows: Vec<Window>,
    pub source: &'static str,
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Slot {
    pub used_percent: f64,
    pub window_minutes: u64,
    pub resets_at: u64, // unix seconds
}

#[derive(Debug, PartialEq, Clone, Default)]
pub struct Limits {
    pub primary: Option<Slot>,
    pub secondary: Option<Slot>,
}

const TAIL: u64 = 64 * 1024;
const DAYS: usize = 7;

pub fn codex_dir() -> PathBuf {
    match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => crate::core::platform::home_dir().join(".codex"),
    }
}

pub fn sessions_dir() -> PathBuf {
    codex_dir().join("sessions")
}

fn slot(v: &Value) -> Option<Slot> {
    Some(Slot {
        used_percent: v.get("used_percent")?.as_f64()?,
        window_minutes: v.get("window_minutes")?.as_u64()?,
        resets_at: v.get("resets_at").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// The last `token_count` line with non-null `rate_limits` in `tail`. A line cut by the tail window simply fails to parse.
pub fn last_limits(tail: &str) -> Option<Limits> {
    tail.lines().rev().find_map(|line| {
        if !line.contains("rate_limits") {
            return None;
        }
        let v: Value = serde_json::from_str(line).ok()?;
        let p = v.get("payload")?;
        if p.get("type")?.as_str()? != "token_count" {
            return None;
        }
        let r = p.get("rate_limits").filter(|r| r.is_object())?;
        let l = Limits { primary: r.get("primary").and_then(slot), secondary: r.get("secondary").and_then(slot) };
        (l.primary.is_some() || l.secondary.is_some()).then_some(l)
    })
}

fn label_of(minutes: u64) -> String {
    match minutes {
        300 => "5 h".into(),
        10080 => "semana".into(),
        n => format!("{n} min"),
    }
}

pub fn windows_of(l: &Limits) -> Vec<Window> {
    [&l.primary, &l.secondary]
        .into_iter()
        .flatten()
        .map(|s| Window {
            label: label_of(s.window_minutes),
            used_pct: Some(s.used_percent),
            resets_at: (s.resets_at > 0).then(|| s.resets_at * 1000),
        })
        .collect()
}

fn mtime(p: &Path) -> SystemTime {
    std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)
}

fn subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v.reverse();
    v
}

/// The most recently written `*.jsonl` in the newest `max_days` day folders (YYYY/MM/DD).
pub fn newest_rollout(sessions: &Path, max_days: usize) -> Option<PathBuf> {
    let mut days = Vec::new();
    'y: for y in subdirs_desc(sessions) {
        for m in subdirs_desc(&y) {
            for d in subdirs_desc(&m) {
                days.push(d);
                if days.len() >= max_days {
                    break 'y;
                }
            }
        }
    }
    days.iter()
        .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .max_by_key(|p| mtime(p))
}

pub fn newest(sessions: &Path) -> Option<PathBuf> {
    newest_rollout(sessions, DAYS)
}

/// Last 64 KiB of the file, lossy (a cut multi-byte char only damages the cut first line).
pub fn read_tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

pub fn usage_from(windows: Vec<Window>, error: Option<String>) -> Usage {
    Usage { agent: "codex".into(), windows, source: "local", at: now_ms(), error }
}

/// Usage of one rollout file, or None when it holds no limits yet.
pub fn read_usage(path: &Path) -> Option<Usage> {
    let l = last_limits(&read_tail(path)?)?;
    Some(usage_from(windows_of(&l), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"timestamp":"2026-10-02T13:27:36.517Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":17534}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":17.0,"window_minutes":300,"resets_at":1790958757},"secondary":{"used_percent":4.0,"window_minutes":10080,"resets_at":1791145739},"plan_type":"team","rate_limit_reached_type":null}}}"#;

    #[test]
    fn last_limits_reads_the_sample() {
        let tail = format!("{LINE}\n{{\"type\":\"other\"}}\n");
        let l = last_limits(&tail).unwrap();
        assert_eq!(l.primary.as_ref().unwrap().used_percent, 17.0);
        assert_eq!(l.secondary.as_ref().unwrap().window_minutes, 10080);
    }

    #[test]
    fn last_limits_takes_the_last_and_skips_null() {
        let newer = LINE.replace("17.0", "20.0");
        let null = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#;
        assert_eq!(last_limits(&format!("{LINE}\n{newer}\n{null}\n")).unwrap().primary.unwrap().used_percent, 20.0);
        assert_eq!(last_limits(null), None);
    }

    #[test]
    fn last_limits_survives_a_cut_first_line() {
        let tail = format!("tion_tokens\":51}}}}}}\n{LINE}");
        assert!(last_limits(&tail).is_some());
        assert_eq!(last_limits("tion_rate_limits\":{\"primary\":"), None);
    }

    #[test]
    fn windows_are_labelled_and_in_ms() {
        let w = windows_of(&last_limits(LINE).unwrap());
        assert_eq!(w[0], Window { label: "5 h".into(), used_pct: Some(17.0), resets_at: Some(1790958757000) });
        assert_eq!(w[1].label, "semana");
        assert_eq!(label_of(60), "60 min");
    }

    #[test]
    fn newest_rollout_looks_at_recent_days_only() {
        let root = std::env::temp_dir().join(format!("coucou-planusage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (d, f) in [("2026/09/01", "old.jsonl"), ("2026/10/01", "a.jsonl"), ("2026/10/02", "b.jsonl"), ("2026/10/02", "note.txt")] {
            let dir = root.join(d);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(f), "x").unwrap();
        }
        let n = newest_rollout(&root, 2).unwrap();
        assert!(n.ends_with("b.jsonl") || n.ends_with("a.jsonl"), "{n:?}");
        assert!(newest_rollout(&root, 1).unwrap().ends_with("b.jsonl"));
        assert_eq!(newest_rollout(&root.join("none"), 7), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
