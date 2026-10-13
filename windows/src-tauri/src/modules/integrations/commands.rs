// Integration commands, same names and argument shapes as at m3-ok. Result-returning ones are gated
// by the host; the unit-returning ones do nothing when the module is off.

use tauri::{AppHandle, Emitter, Manager, State};

use super::{github, github_detail, integrations, reeval, secrets, wake};
use crate::core::host::ModuleHost;
use crate::core::island::WINDOW_LABEL;
use crate::core::platform;

const ID: &str = "integrations";

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
pub fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
pub fn secret_set(app: AppHandle, host: State<ModuleHost>, key: String, value: String) -> Result<(), String> {
    host.require(ID)?;
    secrets::set(&key, &value)?;
    secrets_changed(&app, &key);
    Ok(())
}

#[tauri::command]
pub fn secret_clear(app: AppHandle, host: State<ModuleHost>, key: String) -> Result<(), String> {
    host.require(ID)?;
    secrets::clear(&key)?;
    secrets_changed(&app, &key);
    Ok(())
}

/// The island only learns which keys exist by asking: this tells it to ask again. A new GitHub
/// token may be another account's, so what the old one fetched is forgotten first. The set of
/// providers that have keys moved: the scheduler is re-evaluated.
fn secrets_changed(app: &AppHandle, key: &str) {
    if key == github::TOKEN_KEY {
        github::forget();
    }
    let settings = app.state::<crate::Shared>().settings.lock().unwrap().clone();
    if let Some(ctx) = app.state::<ModuleHost>().ctx(ID) {
        reeval(&ctx, &settings);
    }
    let _ = app.emit_to(WINDOW_LABEL, "secrets-changed", ());
}

/// Settings → GitHub → Test connection. Never brings back the token.
#[tauri::command]
pub async fn github_test(host: State<'_, ModuleHost>) -> Result<github::Account, String> {
    host.require(ID)?;
    github::test().await
}

/// A click on a project in the GitHub panel. On demand only, cached a minute; `force` is the button.
#[tauri::command]
pub async fn github_project(host: State<'_, ModuleHost>, full_name: String, force: bool) -> Result<github::Project, String> {
    host.require(ID)?;
    github::project(&full_name, force).await
}

/// A click on a day of the contribution graph. On demand only, cached.
#[tauri::command]
pub async fn github_day(host: State<'_, ModuleHost>, from: String, to: String, today: bool) -> Result<github::Day, String> {
    host.require(ID)?;
    github::day(&from, &to, today).await
}

/// A click on a line of GitHub activity: the pull request, issue, commits or release behind it.
#[tauri::command]
pub async fn github_detail(
    host: State<'_, ModuleHost>,
    target: github_detail::Target,
    force: bool,
) -> Result<github_detail::Detail, String> {
    host.require(ID)?;
    github_detail::detail(target, force).await
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
pub fn open_n8n(host: State<ModuleHost>) {
    if !host.is_enabled(ID) {
        return;
    }
    if let Some(url) = secrets::get("n8n-url") {
        if url.starts_with("http://") || url.starts_with("https://") {
            platform::open_url(&url);
        }
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
pub async fn refresh_integration(app: AppHandle, host: State<'_, ModuleHost>, id: String) -> Result<(), String> {
    if !host.is_enabled(ID) {
        return Ok(());
    }
    integrations::poll_once(app, &id).await;
    wake(); // a GitHub run may have just started
    Ok(())
}
