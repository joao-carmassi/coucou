// External services behind the island's pills: GitHub, the other pollers, and the secrets they need.
//
// Zero resource when idle: `start`/`apply` work out which providers are ACTIVE (switched on in
// `activeIntegrations` AND with their keys in the Credential Manager). With none, no task exists.
// With some, ONE async task sleeps until the earliest due provider (parked on a Notify, which
// settings saves, secret changes, pause and a manual refresh use to wake it) and ends by itself
// when the last provider goes.

pub mod commands;
pub mod github;
pub mod github_detail;
pub mod integrations;
pub mod secrets;

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::Notify;

use crate::core::host::{Module, ModuleCtx};
use crate::core::settings::Settings;

/// (id as in `activeIntegrations`, first poll after, then every) — the macOS delays and intervals.
const PROVIDERS: &[(&str, u64, u64)] = &[
    ("integration_n8n", 3, 15),
    ("integration_vercel", 5, 30),
    ("integration_stripe", 6, 30),
    ("integration_resend", 6, 60),
    ("integration_github", 7, github::TICK_SECS),
    ("integration_calcom", 8, 300),
    ("integration_notion", 9, 300),
];
const GITHUB: &str = "integration_github";

pub struct Integrations;

struct Sched {
    active: Vec<&'static str>,
    due: BTreeMap<&'static str, Instant>,
    /// While a GitHub run is going: when its runs are asked about next.
    live_due: Option<Instant>,
    paused: bool,
    /// A scheduler task exists (set under the lock, so none is spawned twice).
    running: bool,
}

static ST: Mutex<Sched> =
    Mutex::new(Sched { active: Vec::new(), due: BTreeMap::new(), live_due: None, paused: false, running: false });
static WAKE: Notify = Notify::const_new();

impl Module for Integrations {
    fn id(&self) -> &'static str {
        "integrations"
    }

    fn start(&self, ctx: &ModuleCtx, s: &Settings) {
        reeval(ctx, s);
    }

    fn apply(&self, ctx: &ModuleCtx, s: &Settings) {
        reeval(ctx, s);
    }

    fn stop(&self, _ctx: &ModuleCtx) {
        let mut st = ST.lock().unwrap();
        st.active.clear();
        st.due.clear();
        st.live_due = None;
        st.running = false; // the host aborts the task
    }
}

/// The ids in `activeIntegrations`.
pub fn active_list(s: &Settings) -> Vec<String> {
    s.extra
        .get("activeIntegrations")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Known providers that are listed AND configured, in table order.
fn active_ids(list: &[String], configured: impl Fn(&str) -> bool) -> Vec<&'static str> {
    PROVIDERS.iter().map(|p| p.0).filter(|id| list.iter().any(|x| x == id) && configured(id)).collect()
}

/// Settings saved or a secret changed: recompute the active set, start the scheduler if it is
/// needed and not there, wake it otherwise.
pub fn reeval(ctx: &ModuleCtx, s: &Settings) {
    let ids = active_ids(&active_list(s), secrets::configured);
    let spawn = {
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
        let spawn = !st.active.is_empty() && !st.running && !ctx.stopping();
        st.running |= spawn;
        spawn
    };
    if spawn {
        ctx.spawn_async(run(ctx.app.clone()));
    } else {
        WAKE.notify_one();
    }
}

/// Tray → Pause. Paused means paused: no request leaves. Wakes the scheduler so it parks / resumes.
pub fn set_paused(on: bool) {
    ST.lock().unwrap().paused = on;
    WAKE.notify_one();
}

/// A manual refresh may have started a GitHub run: let the scheduler look again.
fn wake() {
    WAKE.notify_one();
}

async fn run(app: AppHandle) {
    loop {
        let now = Instant::now();
        let (due, live, wait) = {
            let mut st = ST.lock().unwrap();
            if st.active.is_empty() {
                st.running = false;
                return;
            }
            if st.paused {
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

/// The keyring check promised by the module contract. `had_key`: `modulesEnabled.integrations` was
/// stored before the migration ran. Switches the module on only when the key was missing (never
/// overrides a user choice) and a provider listed in `activeIntegrations` has its keys.
pub fn keyring_upgrade(s: &mut Settings, had_key: bool, any_configured: impl Fn(&[String]) -> bool) -> bool {
    if had_key || s.module_on("integrations", false) || !any_configured(&active_list(s)) {
        return false;
    }
    s.modules_enabled.insert("integrations".into(), true);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn active_needs_listing_and_keys() {
        let l = list(&["integration_github", "integration_n8n", "integration_bogus"]);
        assert_eq!(active_ids(&l, |id| id == "integration_github"), vec!["integration_github"]);
        assert!(active_ids(&l, |_| false).is_empty());
        assert!(active_ids(&[], |_| true).is_empty());
        // table order, not list order
        assert_eq!(active_ids(&l, |_| true), vec!["integration_n8n", "integration_github"]);
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

    #[test]
    fn keyring_upgrade_only_when_key_was_missing() {
        let mut s: Settings = serde_json::from_str(r#"{"activeIntegrations":["integration_github"]}"#).unwrap();
        assert!(!keyring_upgrade(&mut s, true, |_| true), "stored key = user choice");
        assert!(!keyring_upgrade(&mut s, false, |_| false), "no keys");
        assert!(keyring_upgrade(&mut s, false, |a| a.len() == 1));
        assert!(s.module_on("integrations", false));
        assert!(!keyring_upgrade(&mut s, false, |_| true), "already on");
        let mut off: Settings = serde_json::from_str(r#"{"modulesEnabled":{"integrations":false}}"#).unwrap();
        assert!(!keyring_upgrade(&mut off, true, |_| true));
        assert!(!off.module_on("integrations", true));
    }
}
