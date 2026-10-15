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

/// One folder's invoke handler. `generate_handler!` cannot be stored directly (E0282), so folders build it through `handler`.
pub type Handler = Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync>;
pub fn handler<F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static>(f: F) -> Handler {
    Box::new(f)
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
pub struct TaskSet(Mutex<(bool, Vec<Task>)>); // (closed by `end`, tasks)

impl Task {
    fn finished(&self) -> bool {
        match self {
            Task::Thread(h) => h.is_finished(),
            Task::Async(h) => h.inner().is_finished(),
        }
    }
}

impl TaskSet {
    /// Drops finished tasks first, so modules that spawn per event (settle threads, pipe connections) stay bounded.
    fn push(&self, t: Task) {
        let mut g = self.0.lock().unwrap();
        if g.0 {
            // Late push after `end` (accept loop mid-poll, watch thread): threads already see the stop flag.
            if let Task::Async(h) = t { h.abort() }
            return;
        }
        g.1.retain(|x| !x.finished());
        g.1.push(t);
    }

    /// Tasks still running (tests).
    #[cfg(test)]
    pub fn live(&self) -> usize {
        self.0.lock().unwrap().1.iter().filter(|t| !t.finished()).count()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().unwrap().1.len()
    }

    /// Aborts async tasks; joins threads within GRACE in total, logs the ones still stuck.
    fn end(&self, id: &str) {
        let tasks = {
            let mut g = self.0.lock().unwrap();
            g.0 = true;
            std::mem::take(&mut g.1)
        };
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

/// Cloneable handle to a module's spawn rights: what ctx.spawn / spawn_async use, for code that outlives `&ModuleCtx`.
#[derive(Clone)]
pub struct Spawner {
    id: &'static str,
    stop: Arc<AtomicBool>,
    tasks: Arc<TaskSet>,
}

impl Spawner {
    /// A thread the host joins on stop.
    pub fn spawn<F: FnOnce(Arc<AtomicBool>) + Send + 'static>(&self, f: F) {
        let stop = self.stop.clone();
        match std::thread::Builder::new().name(format!("module-{}", self.id)).spawn(move || f(stop)) {
            Ok(h) => self.tasks.push(Task::Thread(h)),
            Err(e) => log::line(format!("[module] {}: spawn failed: {e}", self.id)),
        }
    }

    #[cfg(test)]
    pub fn for_test(tasks: &Arc<TaskSet>) -> Self {
        Spawner { id: "test", stop: Arc::new(AtomicBool::new(false)), tasks: tasks.clone() }
    }

    /// An async task the host aborts on stop.
    pub fn spawn_async<F: Future<Output = ()> + Send + 'static>(&self, f: F) {
        self.tasks.push(Task::Async(tauri::async_runtime::spawn(f)));
    }
}

/// One async task shared by several modules (refcounted by its callers): exists only between `ensure` and `end`.
pub struct SharedTask(Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

impl SharedTask {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Starts `fut` unless a previous one is still running.
    pub fn ensure<F: Future<Output = ()> + Send + 'static>(&self, fut: F) {
        let mut h = self.0.lock().unwrap();
        if h.as_ref().is_none_or(|h| h.inner().is_finished()) {
            *h = Some(tauri::async_runtime::spawn(fut));
        }
    }

    pub fn end(&self) {
        if let Some(h) = self.0.lock().unwrap().take() {
            h.abort();
        }
    }
}

pub struct ModuleCtx {
    pub id: &'static str,
    pub app: AppHandle,
    pub stop: Arc<AtomicBool>,
    pub tasks: Arc<TaskSet>,
    listeners: Mutex<Vec<EventId>>,
}

impl ModuleCtx {
    #[allow(dead_code)] // no module needs it since the scheduler became a shared service
    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub fn spawner(&self) -> Spawner {
        Spawner { id: self.id, stop: self.stop.clone(), tasks: self.tasks.clone() }
    }

    /// The only way a module makes a thread: the host joins it on stop.
    pub fn spawn<F: FnOnce(Arc<AtomicBool>) + Send + 'static>(&self, f: F) {
        self.spawner().spawn(f);
    }

    pub fn spawn_async<F: Future<Output = ()> + Send + 'static>(&self, f: F) {
        self.spawner().spawn_async(f);
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

/// Ids of `modules` that have no catalog entry.
fn uncataloged<'a>(catalog: &[ModuleInfo], modules: &'a [Box<dyn Module>]) -> Vec<&'a str> {
    modules.iter().map(|m| m.id()).filter(|id| !catalog.iter().any(|c| c.id == *id)).collect()
}

pub struct ModuleHost {
    catalog: &'static [ModuleInfo],
    modules: Vec<Box<dyn Module>>,
    running: Mutex<HashMap<&'static str, Arc<ModuleCtx>>>,
    effective: Mutex<BTreeMap<String, bool>>,
}

impl ModuleHost {
    pub fn new(catalog: &'static [ModuleInfo], modules: Vec<Box<dyn Module>>) -> Self {
        let missing = uncataloged(catalog, &modules);
        if !missing.is_empty() {
            // Release too: such a module would never start. Fix: a manifest.json for it.
            let msg = format!("Module id(s) {missing:?} not in the catalog (manifest.json): they never start");
            eprintln!("{msg}");
            crate::core::log::line(&msg);
            debug_assert!(false, "{msg}");
        }
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
                    tasks: Arc::default(),
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

    struct Fake(&'static str);
    impl Module for Fake {
        fn id(&self) -> &'static str { self.0 }
        fn start(&self, _: &ModuleCtx, _: &Settings) {}
    }

    /// `registry()` itself cannot run here (it links tauri's GUI, which the test exe has no manifest for);
    /// ModuleHost::new runs this same check on the real list at boot and logs/asserts.
    #[test]
    fn uncataloged_finds_ids_missing_from_the_catalog() {
        let ok: Vec<Box<dyn Module>> = crate::modules::CATALOG.iter().map(|c| Box::new(Fake(c.id)) as Box<dyn Module>).collect();
        assert!(uncataloged(crate::modules::CATALOG, &ok).is_empty());
        let bad: Vec<Box<dyn Module>> = vec![Box::new(Fake("claude")), Box::new(Fake("ghost"))];
        assert_eq!(uncataloged(crate::modules::CATALOG, &bad), vec!["ghost"]);
    }

    fn spawner(tasks: &Arc<TaskSet>) -> Spawner {
        Spawner { id: "t", stop: Arc::new(AtomicBool::new(false)), tasks: tasks.clone() }
    }

    #[test]
    fn taskset_drops_finished_tasks_on_push() {
        let tasks = Arc::new(TaskSet::default());
        let sp = spawner(&tasks);
        for _ in 0..5 {
            sp.spawn(|_| {});
            std::thread::sleep(Duration::from_millis(30));
        }
        assert!(tasks.len() <= 2, "finished threads piled up: {}", tasks.len());
        // a running one is kept; `end` finishes it through the stop flag
        sp.spawn(|stop| while !stop.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(5)) });
        assert!(tasks.len() >= 1);
        sp.stop.store(true, Ordering::SeqCst);
        tasks.end("t");
        assert_eq!(tasks.len(), 0);
        // a push after `end` is dropped, not kept
        sp.spawn(|_| {});
        assert_eq!(tasks.len(), 0);
    }

    #[test]
    fn shared_task_ensure_is_idempotent_and_end_clears() {
        use std::sync::atomic::AtomicUsize;
        static STARTS: AtomicUsize = AtomicUsize::new(0);
        let t = SharedTask::new();
        let job = || async {
            STARTS.fetch_add(1, Ordering::SeqCst);
            std::future::pending::<()>().await
        };
        t.ensure(job());
        t.ensure(job());
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(STARTS.load(Ordering::SeqCst), 1);
        t.end();
        assert!(t.0.lock().unwrap().is_none());
        t.ensure(job());
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(STARTS.load(Ordering::SeqCst), 2);
        t.end();
    }

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
