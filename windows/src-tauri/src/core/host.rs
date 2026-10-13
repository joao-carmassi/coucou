// Module lifecycle: the host starts and stops modules to match settings, and ends every
// thread, task and listener a module made through its ModuleCtx.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, EventId, Listener};

use crate::core::log;
use crate::core::settings::Settings;

pub struct ModuleInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub default_enabled: bool,
    pub requires: &'static [&'static str],
}

pub trait Module: Send + Sync {
    fn id(&self) -> &'static str;
    /// Never called while the module is off. Must not call the host (its lock is held).
    fn start(&self, ctx: &ModuleCtx, s: &Settings);
    /// Unblock what the host cannot end by itself.
    fn stop(&self, _ctx: &ModuleCtx) {}
    /// Settings saved while running.
    fn apply(&self, _ctx: &ModuleCtx, _s: &Settings) {}
}

enum Task {
    Thread(std::thread::JoinHandle<()>),
    Async(tauri::async_runtime::JoinHandle<()>),
}

const GRACE: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct TaskSet(Mutex<Vec<Task>>);

impl TaskSet {
    /// Aborts async tasks; joins threads within GRACE in total, logs the ones still stuck.
    fn end(&self, id: &str) {
        let tasks = std::mem::take(&mut *self.0.lock().unwrap());
        let mut threads = Vec::new();
        for t in tasks {
            match t {
                Task::Async(h) => h.abort(),
                Task::Thread(h) => threads.push(h),
            }
        }
        let deadline = Instant::now() + GRACE;
        while threads.iter().any(|h| !h.is_finished()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        for h in threads {
            if h.is_finished() {
                let _ = h.join();
            } else {
                log::line(format!("[module] {id}: thread still running after stop (detached)"));
            }
        }
    }
}

pub struct ModuleCtx {
    pub id: &'static str,
    pub app: AppHandle,
    pub stop: Arc<AtomicBool>,
    pub tasks: TaskSet,
    listeners: Mutex<Vec<EventId>>,
}

// used by the module ports (M5)
#[allow(dead_code)]
impl ModuleCtx {
    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// The only way a module makes a thread: the host joins it on stop.
    pub fn spawn<F: FnOnce(Arc<AtomicBool>) + Send + 'static>(&self, f: F) {
        let stop = self.stop.clone();
        match std::thread::Builder::new().name(format!("module-{}", self.id)).spawn(move || f(stop)) {
            Ok(h) => self.tasks.0.lock().unwrap().push(Task::Thread(h)),
            Err(e) => log::line(format!("[module] {}: spawn failed: {e}", self.id)),
        }
    }

    pub fn spawn_async<F: Future<Output = ()> + Send + 'static>(&self, f: F) {
        self.adopt(tauri::async_runtime::spawn(f));
    }

    pub fn adopt(&self, h: tauri::async_runtime::JoinHandle<()>) {
        self.tasks.0.lock().unwrap().push(Task::Async(h));
    }

    pub fn listen<F: Fn(tauri::Event) + Send + 'static>(&self, event: &str, f: F) {
        let id = self.app.listen(event, f);
        self.listeners.lock().unwrap().push(id);
    }
}

fn resolve(catalog: &[ModuleInfo], s: &Settings) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    for m in catalog {
        let on = s.module_on(m.id, m.default_enabled) && m.requires.iter().all(|r| out.get(*r) == Some(&true));
        out.insert(m.id.to_string(), on);
    }
    out
}

pub struct ModuleHost {
    catalog: &'static [ModuleInfo],
    modules: Vec<Box<dyn Module>>,
    running: Mutex<HashMap<&'static str, Arc<ModuleCtx>>>,
    effective: Mutex<BTreeMap<String, bool>>,
}

impl ModuleHost {
    pub fn new(catalog: &'static [ModuleInfo], modules: Vec<Box<dyn Module>>) -> Self {
        Self { catalog, modules, running: Mutex::default(), effective: Mutex::default() }
    }

    /// stored ?? default, and every requirement on.
    pub fn resolve(&self, s: &Settings) -> BTreeMap<String, bool> {
        resolve(self.catalog, s)
    }

    /// Boot and every save: stop what went off (reverse order), start what came on, apply on running,
    /// emit `modules-changed` if the map moved. Safe to repeat: a module that stays on only gets `apply`.
    pub fn sync(&self, app: &AppHandle, s: &Settings) {
        let want = self.resolve(s);
        let moved = std::mem::replace(&mut *self.effective.lock().unwrap(), want.clone()) != want;
        for m in self.catalog.iter().rev() {
            if !want[m.id] {
                self.set_enabled(app, m.id, false, s);
            }
        }
        for m in self.catalog {
            if want[m.id] {
                self.set_enabled(app, m.id, true, s);
            }
        }
        if moved {
            let _ = app.emit("modules-changed", want);
        }
    }

    /// Starts (or applies to) / stops one module. A catalog entry with no `impl Module` is a no-op.
    pub fn set_enabled(&self, app: &AppHandle, id: &str, on: bool, s: &Settings) {
        let Some(m) = self.modules.iter().find(|m| m.id() == id) else { return };
        let mut running = self.running.lock().unwrap();
        let live = running.get(m.id()).cloned();
        match (on, live) {
            (true, Some(ctx)) => m.apply(&ctx, s),
            (true, None) => {
                log::line(format!("[module] start {id}"));
                let ctx = Arc::new(ModuleCtx {
                    id: m.id(),
                    app: app.clone(),
                    stop: Arc::new(AtomicBool::new(false)),
                    tasks: TaskSet::default(),
                    listeners: Mutex::default(),
                });
                m.start(&ctx, s);
                running.insert(m.id(), ctx);
            }
            (false, Some(ctx)) => {
                log::line(format!("[module] stop {id}"));
                running.remove(m.id());
                drop(running); // stop/unlisten/end may block or call back into the host
                ctx.stop.store(true, Ordering::SeqCst);
                m.stop(&ctx);
                for l in std::mem::take(&mut *ctx.listeners.lock().unwrap()) {
                    app.unlisten(l);
                }
                ctx.tasks.end(id);
            }
            (false, None) => {}
        }
    }

    // used by the module ports (M5)
    #[allow(dead_code)]
    pub fn is_enabled(&self, id: &str) -> bool {
        self.effective.lock().unwrap().get(id).copied().unwrap_or(false)
    }

    // used by the module ports (M5)
    #[allow(dead_code)]
    pub fn require(&self, id: &str) -> Result<(), String> {
        if self.is_enabled(id) {
            return Ok(());
        }
        let label = self.catalog.iter().find(|m| m.id == id).map_or(id, |m| m.label);
        Err(format!("O módulo {label} está desligado nas Configurações."))
    }

    pub fn state(&self) -> BTreeMap<String, bool> {
        self.effective.lock().unwrap().clone()
    }
}

// used by the module ports (M5)
#[allow(dead_code)]
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_follow_claude() {
        // Free function, not ModuleHost: building a host in a test links all of tauri, which needs a manifest the test exe lacks.
        let mut s = Settings::default();
        s.modules_enabled.insert("claude".into(), false);
        s.modules_enabled.insert("voice".into(), true);
        let m = resolve(crate::modules::CATALOG, &s);
        assert!(!m["claude"] && !m["voice"] && !m["upload"]);
        assert!(m["media"]);
        s.modules_enabled.insert("claude".into(), true);
        let m = resolve(crate::modules::CATALOG, &s);
        assert!(m["voice"] && m["upload"]);
    }
}
