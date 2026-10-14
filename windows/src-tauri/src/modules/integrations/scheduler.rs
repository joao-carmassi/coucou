// ONE scheduler shared by every provider module. The task exists only while >=1 provider is on AND
// configured (`reeval` spawns/aborts it); while paused it parks on the Notify (secret changes,
// module switches, pause and manual refresh wake it).

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::async_runtime::JoinHandle;
use tauri::AppHandle;
use tokio::sync::Notify;

use super::{github, integrations, secrets};

/// (id of the pill/task, first poll after, then every) - the macOS delays and intervals.
pub const PROVIDERS: &[(&str, u64, u64)] = &[
    ("integration_n8n", 3, 15),
    ("integration_vercel", 5, 30),
    ("integration_stripe", 6, 30),
    ("integration_resend", 6, 60),
    ("integration_github", 7, github::TICK_SECS),
    ("integration_calcom", 8, 300),
    ("integration_notion", 9, 300),
];
const GITHUB: &str = "integration_github";

struct Sched {
    /// Provider modules that are on (full ids).
    enabled: Vec<&'static str>,
    /// enabled AND configured.
    active: Vec<&'static str>,
    due: BTreeMap<&'static str, Instant>,
    /// While a GitHub run is going: when its runs are asked about next.
    live_due: Option<Instant>,
    paused: bool,
    handle: Option<JoinHandle<()>>,
    app: Option<AppHandle>,
}

static ST: Mutex<Sched> = Mutex::new(Sched {
    enabled: Vec::new(),
    active: Vec::new(),
    due: BTreeMap::new(),
    live_due: None,
    paused: false,
    handle: None,
    app: None,
});
static REEVAL: Mutex<()> = Mutex::new(());
static WAKE: Notify = Notify::const_new();

/// `github` -> `integration_github`.
fn full(short: &str) -> Option<&'static str> {
    PROVIDERS.iter().map(|p| p.0).find(|id| id.strip_prefix("integration_") == Some(short))
}

/// Known providers that are on AND configured, in table order.
fn active_ids(enabled: &[&str], configured: impl Fn(&str) -> bool) -> Vec<&'static str> {
    PROVIDERS.iter().map(|p| p.0).filter(|id| enabled.contains(id) && configured(id)).collect()
}

/// Provider module started: record the app and re-evaluate (the task spawns only if one is active).
pub fn enable(app: &AppHandle, short: &str) {
    let Some(id) = full(short) else { return };
    {
        let mut st = ST.lock().unwrap();
        st.app = Some(app.clone());
        if !st.enabled.contains(&id) {
            st.enabled.push(id);
        }
    }
    reeval();
}

/// Provider module stopped.
pub fn disable(short: &str) {
    let Some(id) = full(short) else { return };
    ST.lock().unwrap().enabled.retain(|x| *x != id);
    reeval();
}

/// A module switched or a secret changed: recompute the active set, start/stop the task, wake it.
pub fn reeval() {
    let _serial = REEVAL.lock().unwrap(); // whole call: enabled read, keyring read and active write stay ordered
    let enabled = ST.lock().unwrap().enabled.clone();
    let ids = active_ids(&enabled, secrets::configured); // keyring reads outside the ST lock
    let mut st = ST.lock().unwrap();
    let now = Instant::now();
    st.due.retain(|id, _| ids.contains(id));
    for id in &ids {
        let delay = PROVIDERS.iter().find(|p| p.0 == *id).map_or(0, |p| p.1);
        st.due.entry(id).or_insert(now + Duration::from_secs(delay));
    }
    st.active = ids;
    if !st.active.contains(&GITHUB) {
        st.live_due = None;
    }
    if st.active.is_empty() {
        if let Some(h) = st.handle.take() {
            h.abort();
        }
    } else if st.handle.as_ref().is_none_or(|h| h.inner().is_finished()) {
        if let Some(app) = st.app.clone() {
            st.handle = Some(tauri::async_runtime::spawn(run(app)));
        }
    }
    drop(st);
    WAKE.notify_one();
}

/// Tray -> Pause. Paused means paused: no request leaves. Wakes the scheduler so it parks / resumes.
pub fn set_paused(on: bool) {
    ST.lock().unwrap().paused = on;
    WAKE.notify_one();
}

/// A manual refresh may have started a GitHub run: let the scheduler look again.
pub fn wake() {
    WAKE.notify_one();
}

async fn run(app: AppHandle) {
    loop {
        let now = Instant::now();
        let (due, live, wait) = {
            let mut st = ST.lock().unwrap();
            if st.paused || st.active.is_empty() {
                (Vec::new(), false, None)
            } else {
                if st.active.contains(&GITHUB) && github::any_running() {
                    st.live_due.get_or_insert(now + Duration::from_secs(github::LIVE_SECS));
                } else {
                    st.live_due = None;
                }
                let live = st.live_due.is_some_and(|t| t <= now);
                if live {
                    st.live_due = None; // re-armed on the next pass if the run is still going
                }
                let due: Vec<&'static str> = st.due.iter().filter(|(_, t)| **t <= now).map(|(id, _)| *id).collect();
                for id in &due {
                    let every = PROVIDERS.iter().find(|p| p.0 == *id).map_or(60, |p| p.2);
                    st.due.insert(id, now + Duration::from_secs(every));
                }
                let wait = st.due.values().copied().chain(st.live_due).min();
                (due, live, wait)
            }
        };
        let worked = !due.is_empty() || live;
        for id in due {
            let still = ST.lock().unwrap().active.contains(&id);
            if !still {
                continue;
            }
            integrations::poll_once(app.clone(), id).await;
        }
        if live {
            github::refresh_builds(app.clone()).await;
        }
        if worked {
            continue;
        }
        match wait {
            Some(t) => {
                let _ = tokio::time::timeout(t.saturating_duration_since(Instant::now()), WAKE.notified()).await;
            }
            None => WAKE.notified().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_needs_enabled_and_keys() {
        let on = ["integration_github", "integration_n8n", "integration_bogus"];
        assert_eq!(active_ids(&on, |id| id == "integration_github"), vec!["integration_github"]);
        assert!(active_ids(&on, |_| false).is_empty());
        assert!(active_ids(&[], |_| true).is_empty());
        assert_eq!(active_ids(&on, |_| true), vec!["integration_n8n", "integration_github"]);
        assert_eq!(full("calcom"), Some("integration_calcom"));
        assert_eq!(full("x"), None);
    }

    #[test]
    fn intervals_match_the_macos_pollers() {
        let every = |id: &str| PROVIDERS.iter().find(|p| p.0 == id).unwrap().2;
        assert_eq!(every("integration_n8n"), 15);
        assert_eq!(every("integration_vercel"), 30);
        assert_eq!(every("integration_stripe"), 30);
        assert_eq!(every("integration_resend"), 60);
        assert_eq!(every("integration_github"), 120);
        assert_eq!(every("integration_calcom"), 300);
        assert_eq!(every("integration_notion"), 300);
    }
}
