// Sistema: CPU, memória, disco, rede, GPU and temperatures. Nothing runs by itself: the view asks for each sample while it
// is on screen, and the optional alert probe is a plain command the island calls only when alerts are on.

pub mod lhm;
pub mod metrics;

use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::core::host::{blocking, Module, ModuleCtx, ModuleHost};
use crate::core::settings::Settings;

pub struct Sysmon;

static SAMPLER: Mutex<Option<metrics::Sampler>> = Mutex::new(None);
static QUICK_CPU: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);
static ALERT_CPU: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);

/// A panic under the lock must never make release (or the next sample) panic too.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn release() {
    *lock(&SAMPLER) = None;
    *lock(&ALERT_CPU) = None;
    *lock(&QUICK_CPU) = None;
}

impl Module for Sysmon {
    fn id(&self) -> &'static str {
        "sysmon"
    }

    fn start(&self, _ctx: &ModuleCtx, _s: &Settings) {}

    fn stop(&self, _ctx: &ModuleCtx) {
        release();
    }
}

pub const PREFIXES: &[&str] = &["sysmon_"];

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Sysmon)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![
        sysmon_sample, sysmon_release, sysmon_alert_probe, sysmon_quick, sysmon_lhm_info, sysmon_lhm_read, sysmon_lhm_install, sysmon_lhm_open,
    ])
}

fn gate(app: &AppHandle) -> Result<(), String> {
    app.state::<ModuleHost>().require("sysmon")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleOpts {
    pub temps: bool,
}

/// One reading for the open view. The first call after a pause has no rates yet (the view shows a dash).
#[tauri::command]
pub async fn sysmon_sample(app: AppHandle, opts: SampleOpts) -> Result<metrics::Snapshot, String> {
    gate(&app)?;
    blocking(move || lock(&SAMPLER).get_or_insert_with(metrics::Sampler::new).sample(opts.temps)).await
}

/// The view went away: drop the PDH query and the previous readings.
#[tauri::command]
pub async fn sysmon_release() -> Result<(), String> {
    *lock(&SAMPLER) = None;
    Ok(())
}

#[derive(Serialize, Default)]
pub struct Probe {
    pub cpu: Option<f32>,
    pub ram: Option<f32>,
    pub disk: Option<f32>,
}

/// Percent of the system drive in use.
pub fn used_pct(total: u64, free: u64) -> Option<f32> {
    (total > 0).then(|| (total.saturating_sub(free)) as f32 * 100.0 / total as f32)
}

/// Alert check: at most two cheap syscalls per call. CPU (GetSystemTimes) every time, plus memory, or the system
/// drive's free space on every fourth call (it changes slowly).
#[tauri::command]
pub async fn sysmon_alert_probe(app: AppHandle, tick: u32) -> Result<Probe, String> {
    gate(&app)?;
    blocking(move || {
        let mut p = Probe::default();
        let cur = metrics::cpu_times();
        let mut prev = lock(&ALERT_CPU);
        if let (Some(a), Some(b)) = (*prev, cur) {
            p.cpu = metrics::cpu_pct(a, b);
        }
        *prev = cur;
        if tick % 4 == 3 {
            p.disk = metrics::system_drive().and_then(|(t, f)| used_pct(t, f));
        } else {
            p.ram = metrics::ram().and_then(|(u, t)| used_pct(t, t.saturating_sub(u)));
        }
        p
    })
    .await
}

#[derive(Serialize, Default)]
pub struct Quick {
    pub cpu: Option<f32>,
    pub ram: Option<f32>,
}

/// CPU percent since the previous reading (`prev` is replaced); None on the first one or when the counters did not move.
pub fn step_cpu(prev: &mut Option<(u64, u64, u64)>, cur: Option<(u64, u64, u64)>) -> Option<f32> {
    let p = std::mem::replace(prev, cur);
    metrics::cpu_pct(p?, cur?)
}

/// The pinned "Uso do PC" line: GetSystemTimes + GlobalMemoryStatusEx only, no sampler. `fresh` drops the old baseline
/// (the line was just pinned), so the first CPU value covers one interval, not the time since it was last pinned.
#[tauri::command]
pub async fn sysmon_quick(app: AppHandle, fresh: bool) -> Result<Quick, String> {
    gate(&app)?;
    blocking(move || {
        let mut prev = lock(&QUICK_CPU);
        if fresh {
            *prev = None;
        }
        let cpu = step_cpu(&mut prev, metrics::cpu_times());
        let ram = metrics::ram().and_then(|(u, t)| used_pct(t, t.saturating_sub(u)));
        Quick { cpu, ram }
    })
    .await
}

#[tauri::command]
pub fn sysmon_lhm_info(app: AppHandle) -> Result<lhm::Info, String> {
    gate(&app)?;
    Ok(lhm::info())
}

/// `None`: the program is not running or its web server is off.
#[tauri::command]
pub async fn sysmon_lhm_read(app: AppHandle, port: u16) -> Result<Option<Vec<lhm::Reading>>, String> {
    gate(&app)?;
    Ok(lhm::read(port).await)
}

/// Only ever called by the click on "Baixar LibreHardwareMonitor".
#[tauri::command]
pub async fn sysmon_lhm_install(app: AppHandle) -> Result<lhm::Info, String> {
    gate(&app)?;
    lhm::install().await?;
    Ok(lhm::info())
}

#[tauri::command]
pub async fn sysmon_lhm_open(app: AppHandle) -> Result<(), String> {
    gate(&app)?;
    blocking(lhm::open).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_cpu_needs_a_baseline_and_keeps_the_latest() {
        let mut prev = None;
        assert_eq!(step_cpu(&mut prev, Some((0, 100, 100))), None);
        assert_eq!(prev, Some((0, 100, 100)));
        // idle +50 of total (kernel +60, user +40) = 100 -> 50% busy
        assert_eq!(step_cpu(&mut prev, Some((50, 160, 140))), Some(50.0));
        assert_eq!(step_cpu(&mut prev, Some((50, 160, 140))), None, "no time passed");
        assert_eq!(step_cpu(&mut prev, None), None);
        assert_eq!(prev, None);
    }

    #[test]
    fn used_percent() {
        assert_eq!(used_pct(200, 50), Some(75.0));
        assert_eq!(used_pct(0, 0), None);
        assert_eq!(used_pct(100, 500), Some(0.0));
    }

    #[test]
    fn release_clears_everything() {
        *lock(&SAMPLER) = Some(metrics::Sampler::new());
        *lock(&ALERT_CPU) = Some((1, 2, 3));
        release();
        assert!(lock(&SAMPLER).is_none() && lock(&ALERT_CPU).is_none());
    }
}
