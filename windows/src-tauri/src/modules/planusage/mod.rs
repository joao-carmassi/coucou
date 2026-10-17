// Uso do plano: Codex 5 h / weekly limits from the local rollout files (one fswatch thread, no network) and, only when the
// user opted in (planusageClaudeNet), Claude's through claude_net.rs. No timer: the Claude request happens on a command.

pub mod claude_net;
pub mod codex;

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::core::fswatch::{self, Guard};
use crate::core::host::{Module, ModuleCtx, ModuleHost};
use crate::core::island::WINDOW_LABEL;
use crate::core::settings::{self, Settings};
use codex::Usage;

pub const PREFIXES: &[&str] = &["planusage_"];

const CLAUDE_TTL: Duration = Duration::from_secs(5 * 60);

static WATCH: Mutex<Option<Guard>> = Mutex::new(None);
static CODEX: Mutex<Option<Usage>> = Mutex::new(None);
static CLAUDE: Mutex<Option<(Instant, Usage)>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Planusage;

impl Module for Planusage {
    fn id(&self) -> &'static str {
        "planusage"
    }

    fn start(&self, ctx: &ModuleCtx, _s: &Settings) {
        let dir = codex::sessions_dir();
        if !dir.is_dir() {
            *lock(&CODEX) = Some(codex::usage_from(vec![], Some("Codex não encontrado".into())));
            return;
        }
        *lock(&CODEX) = codex::newest(&dir).and_then(|p| codex::read_usage(&p)).or_else(|| Some(codex::usage_from(vec![], None)));
        let app = ctx.app.clone();
        let guard = fswatch::watch(&dir, true, ctx.spawner(), fswatch::DEFAULT_DEBOUNCE_MS, move |paths| on_change(&app, &paths));
        *lock(&WATCH) = Some(guard);
    }

    fn stop(&self, _ctx: &ModuleCtx) {
        *lock(&WATCH) = None; // dropping the Guard ends the watcher thread
        *lock(&CODEX) = None;
        *lock(&CLAUDE) = None;
    }
}

/// The newest rollout among the changed paths: re-read its tail, announce only when the numbers moved.
fn on_change(app: &AppHandle, paths: &[std::path::PathBuf]) {
    let Some(p) = pick_newest(paths) else { return };
    let Some(next) = codex::read_usage(&p) else { return };
    let moved = {
        let mut cur = lock(&CODEX);
        let moved = cur.as_ref().map(|c| &c.windows) != Some(&next.windows);
        if moved {
            *cur = Some(next.clone());
        }
        moved
    };
    if moved {
        let _ = app.emit_to(WINDOW_LABEL, "planusage-changed", vec![next]);
    }
}

fn pick_newest(paths: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    paths
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .cloned()
}

fn net_on(s: &Settings) -> bool {
    s.extra.get("planusageClaudeNet").and_then(serde_json::Value::as_bool) == Some(true)
}

fn fresh(age: Duration) -> bool {
    age < CLAUDE_TTL
}

/// Cached numbers (Codex only; Claude comes from `planusage_claude`).
#[tauri::command]
fn planusage_get(host: State<'_, ModuleHost>) -> Result<Vec<Usage>, String> {
    host.require("planusage")?;
    Ok(lock(&CODEX).clone().into_iter().collect())
}

/// One network read, only with the opt-in on. Result and error are both cached for 5 minutes.
#[tauri::command]
async fn planusage_claude(app: AppHandle) -> Result<Usage, String> {
    app.state::<ModuleHost>().require("planusage")?;
    if !net_on(&settings::load().0) {
        return Err("A consulta de rede do Claude está desligada nas Configurações.".into());
    }
    if let Some((at, u)) = lock(&CLAUDE).as_ref() {
        if fresh(at.elapsed()) {
            return Ok(u.clone());
        }
    }
    let u = match claude_net::fetch().await {
        Ok(w) => Usage { agent: "claude".into(), windows: w, source: "network", at: codex::now_ms(), error: None },
        Err(e) => Usage { agent: "claude".into(), windows: vec![], source: "network", at: codex::now_ms(), error: Some(e) },
    };
    *lock(&CLAUDE) = Some((Instant::now(), u.clone()));
    Ok(u)
}

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Planusage)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![planusage_get, planusage_claude])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_is_off_unless_explicitly_true() {
        let mut s = Settings::default();
        assert!(!net_on(&s));
        s.extra.insert("planusageClaudeNet".into(), serde_json::json!("true"));
        assert!(!net_on(&s));
        s.extra.insert("planusageClaudeNet".into(), serde_json::json!(true));
        assert!(net_on(&s));
    }

    #[test]
    fn cache_lives_five_minutes() {
        assert!(fresh(Duration::from_secs(299)));
        assert!(!fresh(Duration::from_secs(300)));
    }

    #[test]
    fn only_jsonl_paths_count() {
        assert_eq!(pick_newest(&["a.txt".into(), "b.log".into()]), None);
    }
}
