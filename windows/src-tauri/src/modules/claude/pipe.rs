// Claude Code's side of the relay (core/relay.rs owns the pipe and the waits).
//
// Every hook event is forwarded to the island as a `hook` event. A
// `PermissionRequest` keeps its connection open: the island's decision goes back
// on the same connection, which is how approving from the island works.
//
// What we write back is a bare word (`allow`, `deny`, ...). Turning that into
// the documented hookSpecificOutput JSON is coucou-hook's job, so the wire
// format Claude Code expects lives in exactly one place.
//
// One line carries more than a word: `answer {…}`, the answers picked on the
// island to a question Claude asked with its question tool. The relay never
// logs them.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::core::island::WINDOW_LABEL;
use crate::core::log;
use crate::core::relay::{self, Channel};

/// Legacy and default channel: hooks installed before channels existed name none.
pub const CHANNEL: Channel = Channel { name: "", waits, deliver };

fn waits(v: &Value) -> bool {
    v["coucou_wait"] == true || v["hook_event_name"] == "PermissionRequest"
}

fn deliver(app: &AppHandle, mut payload: Value) {
    // The relay forwards CLAUDE_CONFIG_DIR as typed; the island matches profiles
    // by their normalised key.
    if let Some(dir) = payload.get("config_dir").and_then(Value::as_str) {
        payload["config_dir"] = json!(crate::modules::claude::hooks::profile_key(dir));
    }
    let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let event = text("hook_event_name");
    let sid: String = text("session_id").chars().take(8).collect();
    let cfg = text("config_dir");
    match payload.get("request_id").and_then(Value::as_str) {
        Some(id) => log::line(format!("hook {event} id={id} sid={sid} cfg={cfg}")),
        None => log::line(format!("hook {event} sid={sid} cfg={cfg}")),
    }
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" | "always" => "allow",
        "skip" => "skip",
        // A plan: back to planning, or approved and in which mode.
        "plan-keep" => "plan-keep",
        "plan-manual" => "plan-manual",
        "plan-auto" => "plan-auto",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    let _ = relay::reply(app, request_id, word);
}

/// Called when the island answers a question Claude asked: what was picked,
/// keyed by the question's own words. coucou-hook puts it back in the tool's
/// input, which is how Claude Code takes an answer.
pub fn answer_question(app: &AppHandle, request_id: &str, answers: &serde_json::Map<String, Value>) {
    log::line(format!("decision id={request_id} answer"));
    let line = format!("answer {}", Value::Object(answers.clone()));
    if let Err(e) = relay::reply(app, request_id, &line) {
        log::line(format!("decision id={request_id} not sent: {e}"));
    }
}
