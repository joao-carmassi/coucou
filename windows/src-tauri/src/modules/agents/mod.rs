// Agents: Codex, Cursor, Gemini CLI, Copilot CLI and OpenCode on the island. Their hooks talk to the
// relay on the channel "agents"; this side validates who is talking, forwards the event to the island,
// and installs or removes the hook files (always preview + backup + click, see install.rs).
//
// Approval exists only where a blocking hook is known to work (catalog `blocking`). The only words that
// go back are `allow` and `deny`; anything else declines, and the agent asks in its own window.

mod catalog;
mod install;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::core::host::{blocking, Module, ModuleCtx, ModuleHost};
use crate::core::island::WINDOW_LABEL;
use crate::core::relay::{self, Channel};
use crate::core::settings::Settings;
use crate::core::{log, platform};
use catalog::{find, AGENTS};
use install::HookPreview;

pub const PREFIXES: &[&str] = &["agents_"];
const CHANNEL: Channel = Channel { name: "agents", waits, deliver };

pub struct Agents;

impl Module for Agents {
    fn id(&self) -> &'static str {
        "agents"
    }

    fn start(&self, ctx: &ModuleCtx, _s: &Settings) {
        // Old relays take an unknown --flag as the event, so the new one goes first.
        relay::ensure_client_exe(&ctx.app);
        relay::subscribe(ctx, CHANNEL);
    }
}

fn waits(v: &Value) -> bool {
    v["coucou_wait"] == true
}

fn deliver(app: &AppHandle, payload: Value) {
    let request = payload.get("request_id").and_then(Value::as_str).map(str::to_string);
    let def = payload.get("coucou_agent").and_then(Value::as_str).and_then(find);
    let Some(def) = def else {
        // Not one of ours: whoever waits goes back to its own prompt.
        if let Some(id) = request {
            relay::decline(app, &id);
        }
        return;
    };
    if let (Some(id), false) = (&request, def.blocking) {
        relay::decline(app, id);
        return;
    }
    log::line(format!("agents {} {}", payload["hook_event_name"].as_str().unwrap_or(""), def.id));
    let _ = app.emit_to(WINDOW_LABEL, "agents-hook", payload);
}

/// The word that goes back to the relay, or None (= decline). Exactly `allow` or `deny`.
fn decision_word(word: &str) -> Option<&'static str> {
    match word {
        "allow" => Some("allow"),
        "deny" => Some("deny"),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRow {
    id: &'static str,
    label: &'static str,
    color: &'static str,
    installed: bool,
    hooked: bool,
    blocking: bool,
    live: u32,
    config_path: String,
}

#[tauri::command]
fn agents_list(host: State<ModuleHost>) -> Result<Vec<AgentRow>, String> {
    host.require("agents")?;
    Ok(AGENTS
        .iter()
        .map(|a| AgentRow {
            id: a.id,
            label: a.label,
            color: a.color,
            installed: (a.dir)().exists() || platform::find_on_path(a.bin).is_some(),
            hooked: install::hooked(a),
            blocking: a.blocking,
            live: 0,
            config_path: a.path().to_string_lossy().to_string(),
        })
        .collect())
}

fn def_of(agent: &str) -> Result<&'static catalog::AgentDef, String> {
    find(agent).ok_or_else(|| "Agente desconhecido.".to_string())
}

#[tauri::command]
fn agents_preview(host: State<ModuleHost>, agent: String, install: bool) -> Result<HookPreview, String> {
    host.require("agents")?;
    install::preview(def_of(&agent)?, install, &relay::client_exe_path())
}

/// Only ever called from an explicit click in the settings window, with the fingerprint of the preview shown.
#[tauri::command]
async fn agents_apply(app: AppHandle, agent: String, install: bool, fingerprint: String) -> Result<String, String> {
    app.state::<ModuleHost>().require("agents")?;
    let def = def_of(&agent)?;
    blocking(move || install::apply(def, install, &fingerprint, &relay::client_exe_path())).await?
}

/// Only requests that came in on our channel can be answered here; another module's never.
fn own_request(request_id: &str) -> Result<(), String> {
    if relay::is_pending_on(request_id, CHANNEL.name) {
        Ok(())
    } else {
        Err("Pedido desconhecido.".into())
    }
}

/// The island has the card on screen; the long wait may begin.
#[tauri::command]
fn agents_ack(app: AppHandle, host: State<ModuleHost>, request_id: String) -> Result<(), String> {
    host.require("agents")?;
    own_request(&request_id)?;
    relay::ack(&app, &request_id);
    Ok(())
}

/// Nobody can act on this one: the agent asks in its own window at once.
#[tauri::command]
fn agents_decline(app: AppHandle, host: State<ModuleHost>, request_id: String) -> Result<(), String> {
    host.require("agents")?;
    own_request(&request_id)?;
    relay::decline(&app, &request_id);
    Ok(())
}

/// The click on Permitir / Negar. Any other word declines.
#[tauri::command]
fn agents_decide(app: AppHandle, host: State<ModuleHost>, request_id: String, word: String) -> Result<(), String> {
    host.require("agents")?;
    own_request(&request_id)?;
    match decision_word(&word) {
        Some(w) => {
            log::line(format!("agents decision id={request_id} {w}"));
            relay::reply(&app, &request_id, w)
        }
        None => {
            relay::decline(&app, &request_id);
            Ok(())
        }
    }
}

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(Agents)]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![
        agents_list, agents_preview, agents_apply, agents_ack, agents_decline, agents_decide
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_allow_and_deny_are_decisions() {
        assert_eq!(decision_word("allow"), Some("allow"));
        assert_eq!(decision_word("deny"), Some("deny"));
        for w in ["always", "skip", "plan-auto", "Allow", "allow ", "allow\n", "answer {}", ""] {
            assert_eq!(decision_word(w), None, "{w:?}");
        }
    }

    #[test]
    fn the_channel_waits_only_when_the_relay_says_so() {
        assert!(waits(&json!({ "coucou_wait": true })));
        assert!(!waits(&json!({ "hook_event_name": "PermissionRequest" })));
        assert_eq!(CHANNEL.name, "agents");
    }

    #[test]
    fn every_agent_has_a_distinct_valid_id() {
        let ids: std::collections::HashSet<_> = AGENTS.iter().map(|a| a.id).collect();
        assert_eq!(ids.len(), AGENTS.len());
        assert!(AGENTS.iter().all(|a| a.id.bytes().all(|b| b.is_ascii_lowercase())));
    }
}
