// Coucou for Windows — app wiring and the commands the island calls.

mod claude;
#[cfg(windows)]
mod drop_target;
mod files;
mod github;
mod github_detail;
mod focus;
mod hooks;
mod integrations;
mod island;
mod local_claude;
mod log;
mod pipe;
mod platform;
mod secrets;
mod sessions;
mod settings;
mod tray;
mod wsl;

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

/// Gives a terminal we open its own console window (we have none to share).
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
    /// Section the settings window should scroll to. Kept until the window
    /// takes it, because the first-launch offer can fire before its page loads.
    pub settings_section: Mutex<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    // WSL is taken on trust from the last write or refresh: asking every distro
    // here would start their VMs just to draw a dot.
    settings.hooks_installed = any_hooks_installed() || !settings.wsl_hooks.is_empty();
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let mut settings = settings;
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        // Rust's own bookkeeping: a window holding an older copy must not undo it.
        settings.wsl_hooks = current.wsl_hooks.clone();
        settings.wsl_prompted = current.wsl_prompted;
        settings.mochi_session = current.mochi_session.clone();
        if !matches!(settings.ask_mode.as_str(), "sessions" | "mochi") {
            settings.ask_mode = "sessions".into();
        }
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    // The cursor poll skips idle ticks: tell it the window moved under a still cursor.
    island::refresh_click_through(&app, &shared.gate);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// The address the Claude desktop app answers to, through the scheme it registers.
const CLAUDE_APP_URL: &str = "claude://";

/// Brings the Claude desktop app forward. The address is fixed here: nothing
/// the interface sends is run.
#[tauri::command]
fn open_claude_app() {
    platform::open_url(CLAUDE_APP_URL);
}

/// "Open Visual Studio Code" (integration card) opens the working folder in VS
/// Code when `code` is on PATH, and falls back to the file manager otherwise.
///
/// `wsl_distro` is set when the session runs under WSL: the path is then a Linux
/// path, so VS Code opens it through Remote WSL and Explorer through
/// `\\wsl.localhost\<distro>`.
#[tauri::command]
fn open_in_vscode(path: Option<String>, wsl_distro: Option<String>) -> bool {
    let path = path.filter(|p| !p.is_empty());
    let wsl = wsl_target(wsl_distro, path.as_deref());

    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    //
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option. (A
    // WSL path is a Linux path, checked by `wsl_target` instead.)
    if wsl.is_none() {
        if let Some(p) = path.as_deref() {
            let p = std::path::Path::new(p);
            if !(p.is_absolute() && p.is_dir()) {
                return false;
            }
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some((distro, p)) = &wsl {
            cmd.args(["--remote", &format!("wsl+{distro}"), p]);
        } else if let Some(p) = &path {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    match &wsl {
        Some((distro, p)) => {
            platform::reveal_folder(&format!(r"\\wsl.localhost\{distro}{}", p.replace('/', r"\")))
        }
        None => {
            if let Some(p) = path.as_deref() {
                platform::reveal_folder(p);
            }
        }
    }
    false
}

/// "Open terminal" and the ↗ button: bring the session's own terminal window
/// forward, or open one in the session folder — Windows Terminal when installed,
/// a PowerShell console otherwise; a WSL session gets a shell in its own distro.
#[tauri::command]
fn open_terminal(
    path: Option<String>,
    wsl_distro: Option<String>,
    terminal_pids: Option<Vec<u32>>,
) -> bool {
    if focus::existing_terminal(&terminal_pids.unwrap_or_default()) {
        return true;
    }
    let path = path.filter(|p| !p.is_empty());
    let wsl = wsl_target(wsl_distro, path.as_deref());
    // Same check as above: a Windows path must be an existing folder.
    if wsl.is_none() && path.as_deref().is_some_and(|p| !(std::path::Path::new(p).is_absolute() && std::path::Path::new(p).is_dir())) {
        return false;
    }

    // Same rule as above: no shell in between, every value is its own argument.
    // wt still reads `;` as "next command", so a `;` in a folder name is escaped.
    let mut wt = Command::new("wt.exe");
    match (&wsl, &path) {
        (Some((distro, p)), _) => {
            wt.args(["new-tab", "wsl.exe", "-d", distro, "--cd", &p.replace(';', r"\;")]);
        }
        (None, Some(p)) => {
            wt.args(["-d", &p.replace(';', r"\;")]);
        }
        (None, None) => {}
    }
    if wt.spawn().is_ok() {
        return true;
    }

    let mut console = match (&wsl, &path) {
        (Some((distro, p)), _) => {
            let mut cmd = Command::new("wsl.exe");
            cmd.args(["-d", distro, "--cd", p]);
            cmd
        }
        (None, p) => {
            // PowerShell 7 when installed, Windows PowerShell otherwise.
            let shell = |exe: &str| {
                let mut cmd = Command::new(exe);
                cmd.arg("-NoExit").creation_flags(CREATE_NEW_CONSOLE);
                if let Some(p) = p {
                    cmd.current_dir(p);
                }
                cmd
            };
            return shell("pwsh.exe").spawn().or_else(|_| shell("powershell.exe").spawn()).is_ok();
        }
    };
    console.creation_flags(CREATE_NEW_CONSOLE).spawn().is_ok()
}

/// Idle "Open terminal": a fresh console running Claude Code in the home folder,
/// on the account from "Account folder". Never reuses a window. Spawned
/// directly rather than through wt.exe, which may hand the tab to a running
/// Terminal that would not see our CLAUDE_CONFIG_DIR.
/// The Ask tab's "Continue in terminal": the picked session, resumed by an
/// interactive Claude Code in a new console, in that session's own folder
/// (`--resume` looks sessions up by it), on the "Account folder" account.
#[tauri::command]
fn resume_in_terminal(id: String, cwd: Option<String>) -> Result<(), String> {
    if !sessions::is_session_id(&id) {
        return Err("ID de sessão inválido.".into());
    }
    let cli = local_claude::windows_cli().ok_or("O Claude Code não está instalado no Windows.")?;
    let dir = cwd
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
        .unwrap_or_else(files::inbox_dir);
    let config = settings::claude_config_dir();
    claude_console(&cli, &["--resume".to_string(), id], &dir, config.as_deref(), None)
        .map_err(|e| format!("Não foi possível iniciar o Claude Code: {e}"))
}

#[tauri::command]
fn start_claude_terminal() -> bool {
    let Some(cli) = local_claude::windows_cli() else { return false };
    let config = settings::claude_config_dir();
    claude_console(&cli, &[], &platform::home_dir(), config.as_deref(), None).is_ok()
}

/// Single-quoted PowerShell literal; `'` and the typographic quotes PowerShell
/// also reads as quotes are doubled.
fn ps_quote(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}') {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Claude Code in a new console, inside PowerShell 7 so the window stays a
/// shell once Claude exits; straight claude.exe when pwsh isn't installed.
/// `config_dir` is the profile's CLAUDE_CONFIG_DIR (None = the default one).
/// `prompt` travels in the environment, never in the command string.
fn claude_console(
    cli: &std::path::Path,
    args: &[String],
    dir: &std::path::Path,
    config_dir: Option<&std::path::Path>,
    prompt: Option<&str>,
) -> std::io::Result<()> {
    let prepare = |cmd: &mut Command| {
        cmd.current_dir(dir);
        local_claude::fresh_env(cmd);
        if let Some(config) = config_dir {
            cmd.env("CLAUDE_CONFIG_DIR", config);
        }
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    };
    let mut script = String::new();
    if prompt.is_some() {
        script.push_str("$p=$env:COUCOU_PROMPT; Remove-Item Env:COUCOU_PROMPT; ");
    }
    script.push_str(&format!("& {}", ps_quote(&cli.display().to_string())));
    // The prompt goes first: `--add-dir` is variadic and would swallow it as one more folder.
    if prompt.is_some() {
        script.push_str(" $p");
    }
    for a in args {
        script.push(' ');
        script.push_str(&ps_quote(a));
    }
    let mut pwsh = Command::new("pwsh.exe");
    pwsh.args(["-NoLogo", "-NoExit", "-Command"]).arg(script);
    prepare(&mut pwsh);
    if let Some(p) = prompt {
        pwsh.env("COUCOU_PROMPT", p);
    }
    match pwsh.spawn() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut direct = Command::new(cli);
            direct.args(prompt).args(args);
            prepare(&mut direct);
            direct.spawn().map(|_| ())
        }
        other => other.map(|_| ()),
    }
}

fn wsl_target(distro: Option<String>, path: Option<&str>) -> Option<(String, &str)> {
    distro
        .filter(|d| wsl::is_distro_name(d))
        .zip(path.filter(|p| p.starts_with('/')))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

/// `config_dir` from the interface → the folder of a known profile (None = the
/// default one). Anything that is not a profile is refused.
fn profile_dir(config_dir: Option<String>) -> Result<Option<std::path::PathBuf>, String> {
    let Some(dir) = config_dir.filter(|d| !d.trim().is_empty()) else { return Ok(None) };
    let key = hooks::profile_key(&dir);
    let p = sessions::profiles().into_iter().find(|p| p.key == key).ok_or("Perfil desconhecido.")?;
    Ok((!p.is_default).then(|| std::path::PathBuf::from(p.config_dir)))
}

/// Whether any profile has the hooks.
fn any_hooks_installed() -> bool {
    sessions::profiles().iter().any(|p| {
        let dir = (!p.is_default).then(|| std::path::PathBuf::from(&p.config_dir));
        hooks::status_in(dir.as_deref()).installed
    })
}

#[tauri::command]
fn hooks_status(config_dir: Option<String>) -> Result<HookStatus, String> {
    Ok(hooks::status_in(profile_dir(config_dir)?.as_deref()))
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool, config_dir: Option<String>) -> Result<HookPreview, String> {
    hooks::preview_in(profile_dir(config_dir)?.as_deref(), install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
    config_dir: Option<String>,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write_in(profile_dir(config_dir)?.as_deref(), install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = any_hooks_installed() || !current.wsl_hooks.is_empty();
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Claude Code under WSL ─────────────────────────────────────────────────────
// Every one of these may start a distro, which takes seconds: they run off the
// main thread so the windows stay responsive meanwhile.

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Installed distros. Cheap: listing them starts nothing.
#[tauri::command]
async fn wsl_distros() -> Vec<String> {
    blocking(wsl::distros).await.unwrap_or_default()
}

#[tauri::command]
async fn wsl_status(app: AppHandle, distro: String) -> Result<wsl::WslStatus, String> {
    let status = blocking(move || wsl::status(&distro)).await?;
    if status.error.is_none() {
        remember_wsl_hooks(&app, &status.distro, status.installed);
    }
    Ok(status)
}

#[tauri::command]
async fn wsl_hooks_preview(distro: String, install: bool) -> Result<HookPreview, String> {
    blocking(move || wsl::preview(&distro, install)).await?
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
async fn wsl_hooks_apply(
    app: AppHandle,
    distro: String,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let name = distro.clone();
    let backup = blocking(move || wsl::write(&name, install, &fingerprint)).await??;
    remember_wsl_hooks(&app, &distro, install);
    Ok(backup)
}

/// Keeps `wsl_hooks` in step with what a distro really has, so the Claude pill
/// knows hooks exist without asking WSL at every launch.
fn remember_wsl_hooks(app: &AppHandle, distro: &str, installed: bool) {
    let shared = app.state::<Shared>();
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        let had = current.wsl_hooks.iter().any(|d| d == distro);
        if had == installed {
            return;
        }
        if installed {
            current.wsl_hooks.push(distro.to_string());
        } else {
            current.wsl_hooks.retain(|d| d != distro);
        }
        current.hooks_installed = any_hooks_installed() || !current.wsl_hooks.is_empty();
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
}

/// Whether the Claude Code behind "Use for Mochi" (`"windows"` or `"wsl:<d>"`)
/// is signed in. Asked only while the settings window is open.
#[tauri::command]
async fn claude_logged_in(target: String) -> Option<bool> {
    let backend = local_claude::Backend::parse(&target);
    blocking(move || local_claude::logged_in(&backend)).await.ok().flatten()
}

/// First launch after installing: if WSL has distros and none is hooked up yet,
/// open the settings on the WSL section. Offered once; nothing is written until
/// the user reviews the diff and clicks, as everywhere else.
fn offer_wsl_setup(app: AppHandle) {
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        {
            let current = shared.settings.lock().unwrap();
            if current.wsl_prompted || !current.wsl_hooks.is_empty() {
                return;
            }
        }
        if wsl::distros().is_empty() {
            return;
        }
        {
            let mut current = shared.settings.lock().unwrap();
            current.wsl_prompted = true;
            let _ = settings::save(&current);
        }
        log::line("WSL detected — offering to set up its Claude Code hooks");
        show_settings_section(&app, "wsl");
    });
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

/// The island answered a question Claude asked with its question tool.
#[tauri::command]
fn approval_answer(app: AppHandle, request_id: String, answers: serde_json::Map<String, serde_json::Value>) {
    pipe::answer_question(&app, &request_id, &answers);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let (model, backend) = {
        let s = shared.settings.lock().unwrap();
        (s.model.clone(), local_claude::Backend::parse(&s.chat_backend))
    };
    if backend == local_claude::Backend::Api {
        return claude::send(&chat, &model, query, context).await;
    }
    // Claude Code runs as a process for up to minutes: off the main thread.
    let handle = app.clone();
    let reply = blocking(move || {
        let session = handle.state::<local_claude::LocalSession>();
        local_claude::send(&backend, &session, query, context)
    })
    .await?;
    persist_session(&app);
    reply
}

#[tauri::command]
fn chat_reset(app: AppHandle, chat: State<Chat>, session: State<local_claude::LocalSession>) {
    chat.reset();
    session.reset();
    persist_session(&app);
}

// ── Mochi's sessions (local Claude Code only) ─────────────────────────────────
// Reading transcripts goes through \\wsl.localhost for WSL: off the main thread.

fn mochi_backend(app: &AppHandle) -> local_claude::Backend {
    local_claude::Backend::parse(&app.state::<Shared>().settings.lock().unwrap().chat_backend)
}

/// Writes the active session to the settings, so a restart picks it up again.
fn persist_session(app: &AppHandle) {
    let active = app.state::<local_claude::LocalSession>().get(&mochi_backend(app));
    let shared = app.state::<Shared>();
    let mut current = shared.settings.lock().unwrap();
    if current.mochi_session != active {
        current.mochi_session = active;
        let _ = settings::save(&current);
    }
}

#[tauri::command]
async fn sessions_list(app: AppHandle) -> Result<Vec<sessions::SessionInfo>, String> {
    let backend = mochi_backend(&app);
    blocking(move || sessions::list(&backend)).await?
}

#[tauri::command]
async fn session_history(app: AppHandle, id: String) -> Result<Vec<sessions::HistoryItem>, String> {
    let backend = mochi_backend(&app);
    blocking(move || sessions::history(&backend, &id)).await?
}

/// The session Mochi is in, if it belongs to the current engine.
#[tauri::command]
fn session_active(app: AppHandle) -> Option<local_claude::ActiveSession> {
    app.state::<local_claude::LocalSession>().get(&mochi_backend(&app))
}

/// Makes a listed session the active one: Mochi carries it on, in its folder.
#[tauri::command]
fn session_select(app: AppHandle, chat: State<Chat>, id: String, cwd: String) -> Result<(), String> {
    if !sessions::is_session_id(&id) {
        return Err("ID de sessão inválido.".into());
    }
    chat.reset();
    let backend = mochi_backend(&app);
    app.state::<local_claude::LocalSession>().set(Some(local_claude::ActiveSession {
        backend: backend.key(),
        id: Some(id),
        cwd: Some(cwd),
    }));
    persist_session(&app);
    Ok(())
}

/// Erases a session's transcript — the island has already asked twice.
#[tauri::command]
async fn session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let backend = mochi_backend(&app);
    let target = id.clone();
    blocking(move || sessions::delete(&backend, &target)).await??;
    let session = app.state::<local_claude::LocalSession>();
    if session.get(&mochi_backend(&app)).and_then(|a| a.id).as_deref() == Some(id.as_str()) {
        session.reset();
        persist_session(&app);
    }
    Ok(())
}

/// "New in a folder…": the folder picker, then a new session that runs there.
/// `None` when the picker was cancelled.
#[tauri::command]
async fn session_new_in_folder(app: AppHandle) -> Result<Option<String>, String> {
    let backend = mochi_backend(&app);
    let owner = app
        .get_webview_window(island::WINDOW_LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize);
    let key = backend.key();
    let picked = blocking(move || sessions::pick_folder(&backend, owner)).await??;
    if let Some(cwd) = &picked {
        app.state::<Chat>().reset();
        app.state::<local_claude::LocalSession>().set(Some(local_claude::ActiveSession {
            backend: key,
            id: None,
            cwd: Some(cwd.clone()),
        }));
        persist_session(&app);
    }
    Ok(picked)
}

#[tauri::command]
fn claude_profiles() -> Vec<sessions::Profile> {
    sessions::profiles()
}

#[tauri::command]
async fn sessions_all() -> Result<Vec<sessions::ManagedSession>, String> {
    blocking(sessions::list_all).await
}

#[tauri::command]
async fn sessions_live() -> Result<Vec<sessions::LiveSession>, String> {
    blocking(sessions::live).await
}

/// Opens Claude Code in a new console: a new session in `cwd`, `resume` one that
/// is not running, and/or `attach` a file from the inbox. Everything the
/// interface sends is validated here; none of it reaches a command line unchecked.
#[tauri::command]
async fn session_launch(
    profile: String,
    cwd: Option<String>,
    resume: Option<String>,
    attach: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        let p = sessions::profiles()
            .into_iter()
            .find(|p| p.key == profile)
            .ok_or("Perfil desconhecido.")?;
        let mut args: Vec<String> = Vec::new();
        if let Some(id) = &resume {
            if !sessions::is_session_id(id) {
                return Err("ID de sessão inválido.".to_string());
            }
            if sessions::live().iter().any(|l| l.profile == p.key && &l.id == id) {
                return Err("Essa sessão já está aberta.".into());
            }
            args.push("--resume".into());
            args.push(id.clone());
        }
        let mut prompt = None;
        if let Some(file) = &attach {
            let inbox = files::inbox_dir().canonicalize().map_err(|e| e.to_string())?;
            let path = std::path::Path::new(file)
                .canonicalize()
                .ok()
                .filter(|f| f.is_file() && f.starts_with(&inbox))
                .ok_or("Arquivo fora da caixa de entrada do Coucou.")?;
            args.push("--add-dir".into());
            args.push(strip_verbatim(&inbox));
            prompt = Some(format!(
                "Arquivo anexado: @\"{}\". Dê uma olhada e aguarde minhas instruções.",
                strip_verbatim(&path)
            ));
        }
        let dir = cwd
            .map(std::path::PathBuf::from)
            .filter(|d| d.is_absolute() && d.is_dir())
            .unwrap_or_else(platform::home_dir);
        let cli = local_claude::windows_cli().ok_or("O Claude Code não está instalado no Windows.")?;
        let config = (!p.is_default).then(|| std::path::PathBuf::from(&p.config_dir));
        claude_console(&cli, &args, &dir, config.as_deref(), prompt.as_deref())
            .map_err(|e| format!("Não foi possível iniciar o Claude Code: {e}"))
    })
    .await?
}

/// `\\?\C:\x` → `C:\x`: what canonicalize returns is not what Claude Code expects.
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Erases a session's transcript — the island has already asked twice.
#[tauri::command]
async fn session_erase(profile: String, id: String) -> Result<(), String> {
    blocking(move || sessions::erase(&profile, &id)).await?
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// Screenshots the window under the cursor into the inbox (Mochi dragged onto it).
#[tauri::command]
async fn attach_window() -> Result<DroppedFile, String> {
    let (app, w, h, rgb) = platform::capture_under_cursor()?;
    let file = files::save_capture(&app, w, h, &rgb)?;
    log::line(format!("window attached: {app} {w}x{h}"));
    Ok(file)
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)?;
    secrets_changed(&app, &key);
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    secrets::clear(&key)?;
    secrets_changed(&app, &key);
    Ok(())
}

/// The island only learns which keys exist by asking, and used to ask once at
/// launch: a key saved in the settings window left its pill saying "Key not
/// configured" until a restart. This tells it to ask again. A new GitHub token
/// may be another account's: what the old one fetched is forgotten first.
fn secrets_changed(app: &AppHandle, key: &str) {
    if key == github::TOKEN_KEY {
        github::forget();
    }
    let _ = app.emit_to(island::WINDOW_LABEL, "secrets-changed", ());
}

/// Settings → GitHub → Test connection. Runs on the stored token and brings back
/// the account and what the token can reach — never the token itself.
#[tauri::command]
async fn github_test() -> Result<github::Account, String> {
    github::test().await
}

/// A click on a project in the GitHub panel: its CI, last pull request and last
/// deployment. On demand only, cached a minute; `force` is the ↻ button.
#[tauri::command]
async fn github_project(full_name: String, force: bool) -> Result<github::Project, String> {
    github::project(&full_name, force).await
}

/// A click on a day of the contribution graph: what was done that day, between
/// the island's local midnights. On demand only, cached.
#[tauri::command]
async fn github_day(from: String, to: String, today: bool) -> Result<github::Day, String> {
    github::day(&from, &to, today).await
}

/// A click on a line of GitHub activity: the pull request, issue, commits or
/// release behind it, with the files' diffs. On demand only, cached a minute.
#[tauri::command]
async fn github_detail(target: github_detail::Target, force: bool) -> Result<github_detail::Detail, String> {
    github_detail::detail(target, force).await
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
///
/// `CalculateNativeWinOcclusion` off: Chromium sometimes judges the transparent,
/// click-through island occluded at launch and marks the page hidden. Timers and
/// sounds keep running but requestAnimationFrame stops, so the island never
/// grows and never pushes its rect — heard, not seen, not clickable.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// Tauri's hide() does not tell WebView2 the page is hidden. While hidden, mark
/// the webview invisible and ask for a low memory target; restore both before
/// show(). Errors are ignored (older runtimes lack ICoreWebView2_19).
#[cfg(windows)]
fn set_settings_webview_low(win: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core_062::Interface;
    let _ = win.with_webview(move |w| unsafe {
        let _ = w.controller().SetIsVisible(!low);
        if let Ok(core) = w.controller().CoreWebView2() {
            if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                let _ = core.SetMemoryUsageTargetLevel(if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                });
            }
        }
    });
}

#[cfg(not(windows))]
fn set_settings_webview_low(_win: &tauri::WebviewWindow, _low: bool) {}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Configurações — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            set_settings_webview_low(&win, true);
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                    set_settings_webview_low(&hidden, true);
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    show_settings_section(app, "");
}

/// Shows the settings window and tells it which section to scroll to ("" for
/// none). The window also refreshes what is slow to compute (WSL) on this cue.
fn show_settings_section(app: &AppHandle, section: &str) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    *app.state::<Shared>().settings_section.lock().unwrap() = section.to_string();
    set_settings_webview_low(&win, false);
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("settings", "settings-shown", ());
}

/// The section asked for by the last `show_settings_section`, once.
#[tauri::command]
fn take_settings_section(shared: State<Shared>) -> String {
    std::mem::take(&mut *shared.settings_section.lock().unwrap())
}


#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
            settings_section: Mutex::new(String::new()),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage({
            // Back in the session Mochi was in before the restart.
            let session = local_claude::LocalSession::default();
            session.set(loaded.mochi_session.clone());
            session
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            open_claude_app,
            open_terminal,
            start_claude_terminal,
            resume_in_terminal,
            sessions_list,
            session_history,
            session_active,
            session_select,
            session_delete,
            session_new_in_folder,
            claude_profiles,
            sessions_all,
            sessions_live,
            session_launch,
            session_erase,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            wsl_distros,
            wsl_status,
            wsl_hooks_preview,
            wsl_hooks_apply,
            claude_logged_in,
            approval_decision,
            approval_ack,
            approval_decline,
            approval_answer,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            attach_window,
            secret_present,
            secret_set,
            secret_clear,
            github_test,
            github_project,
            github_day,
            github_detail,
            refresh_integration,
            open_n8n,
            open_settings_window,
            take_settings_section,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            offer_wsl_setup(handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
