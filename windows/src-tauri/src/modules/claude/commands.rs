// Claude commands, same names and argument shapes as at m3-ok. Not gated by the host (the module being
// off means the UI does not exist), except the two that start a console and return Result.

use std::os::windows::process::CommandExt;
use std::process::Command;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::core::inbox;
use super::hooks::{HookPreview, HookStatus};
use super::{cfg, focus, hooks, local_claude, pipe, sessions, wsl};
use crate::core::host::{blocking, ModuleHost};
use crate::core::{log, platform, settings};

/// Gives a terminal we open its own console window (we have none to share).
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// The address the Claude desktop app answers to, through the scheme it registers.
const CLAUDE_APP_URL: &str = "claude://";

/// Brings the Claude desktop app forward. The address is fixed here: nothing
/// the interface sends is run.
#[tauri::command]
pub fn claude_open_app() {
    platform::open_url(CLAUDE_APP_URL);
}

/// "Open Visual Studio Code" (integration card) opens the working folder in VS
/// Code when `code` is on PATH, and falls back to the file manager otherwise.
///
/// `wsl_distro` is set when the session runs under WSL: the path is then a Linux
/// path, so VS Code opens it through Remote WSL and Explorer through
/// `\\wsl.localhost\<distro>`.
#[tauri::command]
pub fn claude_open_in_vscode(path: Option<String>, wsl_distro: Option<String>) -> bool {
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
pub fn claude_open_terminal(
    path: Option<String>,
    wsl_distro: Option<String>,
    terminal_pids: Option<Vec<u32>>,
    title: Option<String>,
    cwd: Option<String>,
) -> bool {
    if focus::existing_terminal(&terminal_pids.unwrap_or_default(), title.as_deref(), cwd.as_deref()) {
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
pub fn claude_resume_in_terminal(app: AppHandle, id: String, cwd: Option<String>) -> Result<(), String> {
    app.state::<ModuleHost>().require("claude")?;
    if !sessions::is_session_id(&id) {
        return Err("ID de sessão inválido.".into());
    }
    let cli = local_claude::windows_cli().ok_or("O Claude Code não está instalado no Windows.")?;
    let dir = cwd
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir())
        .unwrap_or_else(inbox::inbox_dir);
    let config = cfg::claude_config_dir();
    claude_console(&cli, &["--resume".to_string(), id], &dir, config.as_deref(), None)
        .map_err(|e| format!("Não foi possível iniciar o Claude Code: {e}"))
}

#[tauri::command]
pub fn claude_start_terminal() -> bool {
    let Some(cli) = local_claude::windows_cli() else { return false };
    let config = cfg::claude_config_dir();
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
pub fn any_hooks_installed() -> bool {
    sessions::profiles().iter().any(|p| {
        let dir = (!p.is_default).then(|| std::path::PathBuf::from(&p.config_dir));
        hooks::status_in(dir.as_deref()).installed
    })
}

#[tauri::command]
pub fn claude_hooks_status(config_dir: Option<String>) -> Result<HookStatus, String> {
    Ok(hooks::status_in(profile_dir(config_dir)?.as_deref()))
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
pub fn claude_hooks_preview(install: bool, config_dir: Option<String>) -> Result<HookPreview, String> {
    hooks::preview_in(profile_dir(config_dir)?.as_deref(), install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
pub fn claude_hooks_apply(
    app: AppHandle,
    shared: State<crate::Shared>,
    install: bool,
    fingerprint: String,
    config_dir: Option<String>,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write_in(profile_dir(config_dir)?.as_deref(), install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        cfg::refresh_hooks_installed(&mut current);
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Claude Code under WSL ─────────────────────────────────────────────────────
// Every one of these may start a distro, which takes seconds: they run off the
// main thread so the windows stay responsive meanwhile.


/// Installed distros. Cheap: listing them starts nothing.
#[tauri::command]
pub async fn claude_wsl_distros() -> Vec<String> {
    blocking(wsl::distros).await.unwrap_or_default()
}

#[tauri::command]
pub async fn claude_wsl_status(app: AppHandle, distro: String) -> Result<wsl::WslStatus, String> {
    let status = blocking(move || wsl::status(&distro)).await?;
    if status.error.is_none() {
        remember_wsl_hooks(&app, &status.distro, status.installed);
    }
    Ok(status)
}

#[tauri::command]
pub async fn claude_wsl_hooks_preview(distro: String, install: bool) -> Result<HookPreview, String> {
    blocking(move || wsl::preview(&distro, install)).await?
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
pub async fn claude_wsl_hooks_apply(
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
    let shared = app.state::<crate::Shared>();
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        let mut list = cfg::wsl_hooks(&current);
        let had = list.iter().any(|d| d == distro);
        if had == installed {
            return;
        }
        if installed {
            list.push(distro.to_string());
        } else {
            list.retain(|d| d != distro);
        }
        cfg::set_wsl_hooks(&mut current, list);
        cfg::refresh_hooks_installed(&mut current);
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
}

#[tauri::command]
pub fn claude_approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
pub fn claude_approval_ack(app: AppHandle, request_id: String) {
    crate::core::relay::ack(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
pub fn claude_approval_decline(app: AppHandle, request_id: String) {
    crate::core::relay::decline(&app, &request_id);
}

/// The island answered a question Claude asked with its question tool.
#[tauri::command]
pub fn claude_approval_answer(app: AppHandle, request_id: String, answers: serde_json::Map<String, serde_json::Value>) {
    pipe::answer_question(&app, &request_id, &answers);
}

// ── Sessions manager ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn claude_profiles() -> Vec<sessions::Profile> {
    sessions::profiles()
}

#[tauri::command]
pub async fn claude_sessions_all() -> Result<Vec<sessions::ManagedSession>, String> {
    blocking(sessions::list_all).await
}

#[tauri::command]
pub async fn claude_sessions_live() -> Result<Vec<sessions::LiveSession>, String> {
    blocking(sessions::live).await
}

/// Opens Claude Code in a new console: a new session in `cwd`, `resume` one that
/// is not running, and/or `attach` a file from the inbox. Everything the
/// interface sends is validated here; none of it reaches a command line unchecked.
#[tauri::command]
pub async fn claude_session_launch(
    app: AppHandle,
    profile: String,
    cwd: Option<String>,
    resume: Option<String>,
    attach: Option<String>,
    prompt: Option<String>,
) -> Result<(), String> {
    app.state::<ModuleHost>().require("claude")?;
    let r = blocking(move || {
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
        // A typed or dictated first message: travels in the environment (claude_console), never on a command line.
        let mut prompt = prompt
            .map(|t| t.trim().trim_start_matches('-').trim_start().chars().take(2000).collect::<String>())
            .filter(|t| !t.is_empty());
        if let Some(file) = &attach {
            let inbox = inbox::inbox_dir().canonicalize().map_err(|e| e.to_string())?;
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
        log::line(format!("session launch: attach={} dir={}", attach.is_some(), dir.display()));
        claude_console(&cli, &args, &dir, config.as_deref(), prompt.as_deref())
            .map_err(|e| format!("Não foi possível iniciar o Claude Code: {e}"))
    })
    .await?;
    log::line(match &r {
        Ok(()) => "session launch: spawned".to_string(),
        Err(e) => format!("session launch failed: {e}"),
    });
    r
}

/// `\\?\C:\x` → `C:\x`: what canonicalize returns is not what Claude Code expects.
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Erases a session's transcript — the island has already asked twice.
#[tauri::command]
pub async fn claude_session_erase(profile: String, id: String) -> Result<(), String> {
    blocking(move || sessions::erase(&profile, &id)).await?
}
