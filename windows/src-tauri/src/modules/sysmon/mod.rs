// Sistema: CPU, memória, disco, rede, GPU and temperatures. Nothing runs by itself: the view asks for each sample while it
// is on screen, and the optional alert probe is a plain command the island calls only when alerts are on.

pub mod lhm;
pub mod metrics;
pub mod tools;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::core::host::{blocking, Module, ModuleCtx, ModuleHost};
use crate::core::settings::Settings;

pub struct Sysmon;

static SAMPLER: Mutex<Option<metrics::Sampler>> = Mutex::new(None);
static ALERT_CPU: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);

fn release() {
    *SAMPLER.lock().unwrap() = None;
    *ALERT_CPU.lock().unwrap() = None;
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
        sysmon_sample, sysmon_release, sysmon_alert_probe, sysmon_ports, sysmon_kill, sysmon_speedtest, sysmon_endpoint,
        sysmon_lhm_info, sysmon_lhm_read, sysmon_lhm_install, sysmon_lhm_open,
    ])
}

fn gate(app: &AppHandle) -> Result<(), String> {
    app.state::<ModuleHost>().require("sysmon")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleOpts {
    pub procs: bool,
    pub temps: bool,
}

/// One reading for the open view. The first call after a pause has no rates yet (the view shows a dash).
#[tauri::command]
pub async fn sysmon_sample(app: AppHandle, opts: SampleOpts) -> Result<metrics::Snapshot, String> {
    gate(&app)?;
    blocking(move || SAMPLER.lock().unwrap().get_or_insert_with(metrics::Sampler::new).sample(opts.procs, opts.temps)).await
}

/// The view went away: drop the PDH query and the previous readings.
#[tauri::command]
pub async fn sysmon_release() -> Result<(), String> {
    *SAMPLER.lock().unwrap() = None;
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
        let mut prev = ALERT_CPU.lock().unwrap();
        if let (Some(a), Some(b)) = (*prev, cur) {
            p.cpu = metrics::cpu_pct(a, b);
        }
        *prev = cur;
        if tick % 4 == 3 {
            let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            p.disk = metrics::disks().into_iter().find(|d| d.name.eq_ignore_ascii_case(&drive)).and_then(|d| used_pct(d.total, d.free));
        } else {
            p.ram = metrics::ram().and_then(|(u, t)| used_pct(t, t.saturating_sub(u)));
        }
        p
    })
    .await
}

#[tauri::command]
pub async fn sysmon_ports(app: AppHandle) -> Result<Vec<tools::Port>, String> {
    gate(&app)?;
    blocking(tools::listening_ports).await
}

#[tauri::command]
pub async fn sysmon_kill(app: AppHandle, pid: u32, name: String) -> Result<(), String> {
    gate(&app)?;
    blocking(move || tools::kill(pid, &name)).await?
}

/// The host a speed test would contact, for the label next to the button.
#[tauri::command]
pub fn sysmon_endpoint(url: String) -> Result<String, String> {
    tools::endpoint_host(&url)
}

#[tauri::command]
pub async fn sysmon_speedtest(app: AppHandle, url: String) -> Result<tools::SpeedResult, String> {
    gate(&app)?;
    tools::speedtest(&url).await
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
    fn used_percent() {
        assert_eq!(used_pct(200, 50), Some(75.0));
        assert_eq!(used_pct(0, 0), None);
        assert_eq!(used_pct(100, 500), Some(0.0));
    }

    #[test]
    fn release_clears_everything() {
        *SAMPLER.lock().unwrap() = Some(metrics::Sampler::new());
        *ALERT_CPU.lock().unwrap() = Some((1, 2, 3));
        release();
        assert!(SAMPLER.lock().unwrap().is_none() && ALERT_CPU.lock().unwrap().is_none());
    }
}
