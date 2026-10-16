// Calendar from ICS feeds. A feed URL is a secret (it carries an access token): it lives only in the Credential
// Manager (owner `calendar`, keys `ics1`..`ics5`), is never sent to the webview (only its host), never written to
// settings.json and never logged. The webview asks for a download by slot and parses the text itself.
// No thread, no timer: a download happens only when the webview asks.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use reqwest::redirect::Policy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::core::host::{Module, ModuleCtx, ModuleHost};
use crate::core::island::WINDOW_LABEL;
use crate::core::secrets;
use crate::core::settings::Settings;

pub const PREFIXES: &[&str] = &["calendar_"];

const OWNER: &str = "calendar";
/// Credential Manager blobs are small; this keeps a URL well inside the limit.
const MAX_URL: usize = 1000;
const SLOTS: u8 = 5;
const MAX_BODY: usize = 8 * 1024 * 1024;

/// ETag / Last-Modified of the last download of a slot. Memory only; cleared when the module stops.
#[derive(Clone, Default)]
struct Validators {
    etag: Option<String>,
    modified: Option<String>,
}
static CACHE: Mutex<Option<HashMap<u8, Validators>>> = Mutex::new(None);

fn cache_get(slot: u8) -> Option<Validators> {
    CACHE.lock().ok()?.as_ref()?.get(&slot).cloned()
}
fn cache_set(slot: u8, v: Option<Validators>) {
    if let Ok(mut g) = CACHE.lock() {
        let map = g.get_or_insert_with(HashMap::new);
        match v {
            Some(v) => map.insert(slot, v),
            None => map.remove(&slot),
        };
    }
}

struct Calendar;

impl Module for Calendar {
    fn id(&self) -> &'static str {
        "calendar"
    }
    fn start(&self, _ctx: &ModuleCtx, _s: &Settings) {}
    fn stop(&self, _ctx: &ModuleCtx) {
        if let Ok(mut g) = CACHE.lock() {
            *g = None;
        }
    }
}

// ── pure ─────────────────────────────────────────────────────────────────────

/// `webcal://` is https in disguise; anything else but https is refused. Errors never repeat the text.
fn normalize(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    let t = if lower.starts_with("webcals://") {
        format!("https://{}", &t["webcals://".len()..])
    } else if lower.starts_with("webcal://") {
        format!("https://{}", &t["webcal://".len()..])
    } else {
        t.to_string()
    };
    if t.is_empty() || t.len() > MAX_URL || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Link inválido.".into());
    }
    if !t.to_ascii_lowercase().starts_with("https://") {
        return Err("Use um link que comece com https://".into());
    }
    let u = reqwest::Url::parse(&t).map_err(|_| "Link inválido.".to_string())?;
    if u.host_str().is_none_or(|h| h.is_empty()) {
        return Err("Link inválido.".into());
    }
    Ok(u.to_string())
}

/// What the webview may see of a feed: the host, never the path or the query.
fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

fn free_slot(used: &[u8]) -> Option<u8> {
    (1..=SLOTS).find(|s| !used.contains(s))
}

fn key(slot: u8) -> Result<String, String> {
    if (1..=SLOTS).contains(&slot) { Ok(format!("ics{slot}")) } else { Err("Calendário desconhecido.".into()) }
}

fn stored(slot: u8) -> Option<String> {
    secrets::get(OWNER, &key(slot).ok()?)
}

// ── network ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    slot: u8,
    host: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    not_modified: bool,
    body: String,
}

/// The error text names the cause, never the URL (reqwest's own messages include it).
async fn download(url: &str, prev: Option<Validators>) -> Result<(Fetched, Validators), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(Policy::custom(|a| if a.previous().len() < 5 && a.url().scheme() == "https" { a.follow() } else { a.stop() }))
        .user_agent("Coucou")
        .build()
        .map_err(|_| "Falha ao preparar a conexão.".to_string())?;
    let mut req = client.get(url);
    if let Some(v) = &prev {
        if let Some(e) = &v.etag {
            req = req.header(IF_NONE_MATCH, e);
        }
        if let Some(m) = &v.modified {
            req = req.header(IF_MODIFIED_SINCE, m);
        }
    }
    let resp = req.send().await.map_err(|e| if e.is_timeout() { "Tempo esgotado.".to_string() } else { "Sem conexão com o calendário.".to_string() })?;
    let status = resp.status();
    if status.as_u16() == 304 {
        return Ok((Fetched { not_modified: true, body: String::new() }, prev.unwrap_or_default()));
    }
    if !status.is_success() {
        return Err(format!("O calendário respondeu {}.", status.as_u16()));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BODY) {
        return Err("O calendário é grande demais.".into());
    }
    let header = |h| resp.headers().get(h).and_then(|v| v.to_str().ok()).map(str::to_string);
    let v = Validators { etag: header(ETAG), modified: header(LAST_MODIFIED) };
    // shortcut: the whole body is read before the size check when the server sends no length; 20 s timeout bounds it.
    let body = resp.text().await.map_err(|_| "Falha ao ler o calendário.".to_string())?;
    if body.len() > MAX_BODY {
        return Err("O calendário é grande demais.".into());
    }
    Ok((Fetched { not_modified: false, body }, v))
}

fn changed(app: &AppHandle) {
    let _ = app.emit_to(WINDOW_LABEL, "calendar-changed", ());
}

// ── commands ─────────────────────────────────────────────────────────────────

/// The feeds, as slot + host. The URL itself never leaves Rust.
#[tauri::command]
fn calendar_list(host: State<ModuleHost>) -> Result<Vec<Feed>, String> {
    host.require("calendar")?;
    Ok((1..=SLOTS).filter_map(|slot| stored(slot).map(|u| Feed { slot, host: host_of(&u) })).collect())
}

#[tauri::command]
fn calendar_add(app: AppHandle, host: State<ModuleHost>, url: String) -> Result<Feed, String> {
    host.require("calendar")?;
    let url = normalize(&url)?;
    let used: Vec<u8> = (1..=SLOTS).filter(|s| stored(*s).is_some()).collect();
    if (1..=SLOTS).any(|s| stored(s).as_deref() == Some(url.as_str())) {
        return Err("Esse link já foi adicionado.".into());
    }
    let slot = free_slot(&used).ok_or_else(|| format!("No máximo {SLOTS} calendários."))?;
    secrets::set(OWNER, &key(slot)?, &url)?;
    cache_set(slot, None);
    changed(&app);
    Ok(Feed { slot, host: host_of(&url) })
}

#[tauri::command]
fn calendar_remove(app: AppHandle, host: State<ModuleHost>, slot: u8) -> Result<(), String> {
    host.require("calendar")?;
    secrets::delete(OWNER, &key(slot)?)?;
    cache_set(slot, None);
    changed(&app);
    Ok(())
}

/// Downloads one feed. `have`: the webview still holds the last text, so a conditional request may answer "not modified".
#[tauri::command]
async fn calendar_fetch(host: State<'_, ModuleHost>, slot: u8, have: bool) -> Result<Fetched, String> {
    host.require("calendar")?;
    let url = stored(slot).ok_or_else(|| "Calendário não encontrado.".to_string())?;
    let prev = if have { cache_get(slot) } else { None };
    let (out, v) = download(&url, prev).await?;
    cache_set(slot, Some(v));
    Ok(out)
}

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Calendar)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![calendar_list, calendar_add, calendar_remove, calendar_fetch])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_accepts_https_and_webcal_only() {
        assert_eq!(normalize("  https://calendar.google.com/calendar/ical/x/private-abc/basic.ics ").unwrap(), "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics");
        assert_eq!(normalize("webcal://example.com/a.ics?t=1").unwrap(), "https://example.com/a.ics?t=1");
        assert_eq!(normalize("WEBCALS://example.com/a.ics").unwrap(), "https://example.com/a.ics");
        for bad in ["", "http://example.com/a.ics", "ftp://x/y", "file:///c:/a.ics", "https://", "https://exa mple.com/", "javascript:alert(1)"] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
        assert!(normalize(&format!("https://example.com/{}", "a".repeat(MAX_URL))).is_err());
    }

    #[test]
    fn errors_never_echo_the_url() {
        let secret = "https://example.com/private-SECRETTOKEN/a b.ics";
        assert!(!normalize(secret).unwrap_err().contains("SECRET"));
        assert!(!normalize("http://example.com/SECRETTOKEN").unwrap_err().contains("SECRET"));
    }

    #[test]
    fn host_hides_path_and_query() {
        assert_eq!(host_of("https://outlook.office365.com/owa/calendar/abc/reachcalendar.ics?x=SECRET"), "outlook.office365.com");
        assert_eq!(host_of("not a url"), "");
    }

    #[test]
    fn slots() {
        assert_eq!(free_slot(&[]), Some(1));
        assert_eq!(free_slot(&[1, 3]), Some(2));
        assert_eq!(free_slot(&[1, 2, 3, 4, 5]), None);
        assert!(key(0).is_err() && key(6).is_err());
        assert_eq!(key(5).unwrap(), "ics5");
    }

    #[test]
    fn cache_round_trip() {
        cache_set(4, Some(Validators { etag: Some("\"a\"".into()), modified: None }));
        assert_eq!(cache_get(4).unwrap().etag.as_deref(), Some("\"a\""));
        cache_set(4, None);
        assert!(cache_get(4).is_none());
    }
}
