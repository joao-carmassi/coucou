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
    /// Settings heading the module is listed under (None: on its own).
    #[allow(dead_code)] // mirrored by the TS catalog (Settings grouping); Rust only declares it
    pub group: Option<&'static str>,
}

pub trait Module: Send + Sync {
    fn id(&self) -> &'static str;
    /// Never called while the module is off. Must not call the host (its lock is held).
    fn start(&self, ctx: &ModuleCtx, s: &Settings);
    /// Unblock what the host cannot end by itself.
    fn stop(&self, _ctx: &ModuleCtx) {}
    /// Settings saved while running.
    fn apply(&self, _ctx: &ModuleCtx, _s: &Settings) {}
    /// Builder time, once per module (on or off): register Tauri state only. No threads, no timers.
    fn setup(&self, _app: &AppHandle) {}
    /// Legacy settings.json shapes -> `modulesEnabled` / own keys. Only fill what is missing; true if changed.
    fn migrate(&self, _s: &mut Settings) -> bool {
        false
    }
    /// `save_settings`: `current` is what Rust holds, `incoming` what the window sent (edit it in place).
    /// Keep Rust-owned keys, clean values, write legacy mirrors. Runs for every module, on or off.
    fn on_save(&self, _current: &Settings, _incoming: &mut Settings) {}
    /// `boot`, while the module is on: refresh what the window must see fresh.
    fn boot(&self, _s: &mut Settings) {}
    /// Tray Pause. Runs for every module, on or off (the flag outlives the module).
    fn pause(&self, _paused: bool) {}
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

impl ModuleCtx {
    #[allow(dead_code)] // no module needs it since the scheduler became a shared service
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

    #[allow(dead_code)]
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

    /// Settings loaded from disk: modules migrate their legacy keys, then every id still missing gets
    /// its catalog default. True when settings.json should be rewritten.
    pub fn migrate(&self, s: &mut Settings) -> bool {
        let mut changed = false;
        for m in &self.modules {
            changed |= m.migrate(s);
        }
        crate::core::settings::fill_defaults(self.catalog, s) | changed
    }

    pub fn setup(&self, app: &AppHandle) {
        self.modules.iter().for_each(|m| m.setup(app));
    }

    pub fn on_save(&self, current: &Settings, incoming: &mut Settings) {
        self.modules.iter().for_each(|m| m.on_save(current, incoming));
    }

    pub fn boot(&self, s: &mut Settings) {
        for m in self.modules.iter().filter(|m| self.is_enabled(m.id())) {
            m.boot(s);
        }
    }

    pub fn pause(&self, paused: bool) {
        self.modules.iter().for_each(|m| m.pause(paused));
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.effective.lock().unwrap().get(id).copied().unwrap_or(false)
    }

    pub fn require(&self, id: &str) -> Result<(), String> {
        if self.is_enabled(id) {
            return Ok(());
        }
        let label = self.catalog.iter().find(|m| m.id == id).map_or(id, |m| m.label);
        Err(format!("O módulo {label} está desligado nas Configurações."))
    }

    /// The live context of a running module (for threads started from a hotkey or a command).
    pub fn ctx(&self, id: &str) -> Option<Arc<ModuleCtx>> {
        self.running.lock().unwrap().get(id).cloned()
    }

    pub fn state(&self) -> BTreeMap<String, bool> {
        self.effective.lock().unwrap().clone()
    }
}

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
