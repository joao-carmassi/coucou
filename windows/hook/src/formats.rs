//! What each agent's hook speaks, translated to the Claude-like events Coucou
//! understands, and Coucou's one-word answer translated back.
//!
//! `claude` is the default and stays exactly as it always was. The others only
//! rename events and fields; none of them ever adds an auto-approve path: the
//! words that go back are `allow` and `deny`, nothing else.

use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Claude,
    Codex,
    Gemini,
    Cursor,
    Copilot,
    Opencode,
}

impl Format {
    /// Unknown or empty = claude, so hooks installed before formats existed keep working.
    pub fn parse(s: &str) -> Format {
        match s {
            "codex" => Format::Codex,
            "gemini" => Format::Gemini,
            "cursor" => Format::Cursor,
            "copilot" => Format::Copilot,
            "opencode" => Format::Opencode,
            _ => Format::Claude,
        }
    }
}

/// Does this event of this format block on the island's word?
/// Copilot is observe-only: its reply envelope is documented but not yet seen working.
pub fn waits(format: Format, event: &str) -> bool {
    matches!(format, Format::Claude | Format::Codex | Format::Cursor) && event == "PermissionRequest"
}

/// Renames the event and fields to the Claude-like names. `event` is what the
/// payload said (or argv) in the agent's own spelling; the result carries
/// `hook_event_name` in Claude's. Returns the final event name.
pub fn normalise(format: Format, map: &mut Map<String, Value>, event: &str) -> String {
    let text = |map: &Map<String, Value>, k: &str| map.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let event = match format {
        Format::Gemini => match event {
            "BeforeAgent" => "UserPromptSubmit",
            "BeforeTool" => "PreToolUse",
            "AfterTool" => "PostToolUse",
            "AfterAgent" => {
                if let Some(v) = map.remove("prompt_response") {
                    map.insert("last_assistant_message".into(), v);
                }
                "Stop"
            }
            "Notification" => {
                // A permission prompt: ending in "?" is what makes the pill say "ask".
                if text(map, "notification_type") == "ToolPermission" {
                    let m = text(map, "message");
                    let m = if m.trim().is_empty() { "Aprovação pendente".to_string() } else { m.trim_end().to_string() };
                    map.insert("message".into(), Value::String(if m.ends_with('?') { m } else { format!("{m}?") }));
                }
                "Notification"
            }
            other => other,
        }
        .to_string(),
        Format::Cursor => {
            map.remove("user_email");
            map.remove("model_params");
            if let Some(v) = map.remove("conversation_id") {
                map.insert("session_id".into(), v);
            }
            let root = map.get("workspace_roots").and_then(|v| v.get(0)).cloned();
            if let (Some(root), true) = (root, text(map, "cwd").is_empty()) {
                map.insert("cwd".into(), root);
            }
            match event {
                "sessionStart" => "SessionStart".into(),
                "sessionEnd" => "SessionEnd".into(),
                "postToolUse" => "PostToolUse".into(),
                "stop" if text(map, "status") == "error" => "StopFailure".into(),
                "stop" => "Stop".into(),
                "beforeShellExecution" => {
                    let command = map.remove("command").unwrap_or(Value::Null);
                    map.insert("tool_name".into(), json!("Shell"));
                    map.insert("tool_input".into(), json!({ "command": command }));
                    "PermissionRequest".into()
                }
                other => other.into(),
            }
        }
        _ => event.to_string(),
    };
    map.insert("hook_event_name".into(), Value::String(event.clone()));
    if waits(format, &event) {
        map.insert("coucou_wait".into(), Value::Bool(true));
    }
    event
}

/// The answer to print for a word from the island; None = print nothing.
/// `claude` is handled by the caller (it also answers questions and plans).
pub fn reply(format: Format, word: &str) -> Option<String> {
    let word = word.trim();
    match format {
        Format::Codex => {
            let behavior = match word {
                "allow" => r#"{"behavior":"allow"}"#,
                "deny" => r#"{"behavior":"deny","message":"Negado pelo Coucou"}"#,
                _ => return None,
            };
            Some(format!(r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#))
        }
        Format::Cursor => Some(cursor_json(match word {
            "allow" => "allow",
            "deny" => "deny",
            _ => "ask",
        })),
        _ => None,
    }
}

fn cursor_json(permission: &str) -> String {
    match permission {
        "deny" => r#"{"continue":true,"permission":"deny","user_message":"Negado pelo Coucou"}"#.into(),
        p => format!(r#"{{"continue":true,"permission":"{p}"}}"#),
    }
}

/// What to print when there is no word at all (Coucou closed, no pipe, bad
/// stdin, timeout). Cursor blocks the action on empty output, so it always
/// gets "ask": its own prompt, as if we were not there. `event` may be empty.
pub fn fallback(format: Format, event: &str) -> Option<String> {
    (format == Format::Cursor && (event.is_empty() || event == "PermissionRequest")).then(|| cursor_json("ask"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(format: Format, event: &str, payload: Value) -> (String, Value) {
        let mut map = payload.as_object().unwrap().clone();
        let ev = normalise(format, &mut map, event);
        (ev, Value::Object(map))
    }

    #[test]
    fn claude_payload_is_only_named_and_stamped() {
        let input = json!({ "hook_event_name": "PermissionRequest", "session_id": "s", "tool_name": "Bash", "tool_input": { "command": "ls" } });
        let (ev, out) = run(Format::Claude, "PermissionRequest", input.clone());
        assert_eq!(ev, "PermissionRequest");
        let mut expected = input;
        expected["coucou_wait"] = json!(true);
        assert_eq!(out, expected);
        let (_, stop) = run(Format::Claude, "Stop", json!({ "session_id": "s" }));
        assert_eq!(stop, json!({ "session_id": "s", "hook_event_name": "Stop" }));
        // Unknown format words are claude.
        assert_eq!(Format::parse(""), Format::Claude);
        assert_eq!(Format::parse("future"), Format::Claude);
    }

    #[test]
    fn claude_answers_are_unchanged_by_formats() {
        // reply() never speaks for claude: main keeps its own reply_json (see its tests).
        assert!(reply(Format::Claude, "allow").is_none());
    }

    #[test]
    fn codex_waits_and_answers_only_allow_or_deny() {
        let (ev, out) = run(Format::Codex, "PermissionRequest", json!({ "session_id": "s", "tool_name": "shell" }));
        assert_eq!((ev.as_str(), &out["coucou_wait"]), ("PermissionRequest", &json!(true)));
        let allow = reply(Format::Codex, "allow").unwrap();
        assert_eq!(allow, r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#);
        assert!(reply(Format::Codex, "deny").unwrap().contains(r#""behavior":"deny""#));
        for w in ["always", "skip", "plan-auto", "answer {}", "", "ALLOW"] {
            assert!(reply(Format::Codex, w).is_none(), "{w}");
        }
        assert!(!reply(Format::Codex, "allow").unwrap().contains("updatedInput"));
    }

    #[test]
    fn gemini_is_renamed_and_never_waits() {
        let (ev, out) = run(Format::Gemini, "AfterAgent", json!({ "session_id": "g", "prompt_response": "feito" }));
        assert_eq!(ev, "Stop");
        assert_eq!(out["last_assistant_message"], "feito");
        assert!(out.get("coucou_wait").is_none());
        assert_eq!(run(Format::Gemini, "BeforeAgent", json!({})).0, "UserPromptSubmit");
        assert_eq!(run(Format::Gemini, "BeforeTool", json!({})).0, "PreToolUse");
        assert_eq!(run(Format::Gemini, "AfterTool", json!({})).0, "PostToolUse");
        let (_, note) = run(Format::Gemini, "Notification", json!({ "notification_type": "ToolPermission", "message": "Run ls" }));
        assert_eq!(note["message"], "Run ls?");
        assert!(reply(Format::Gemini, "allow").is_none() && fallback(Format::Gemini, "").is_none());
    }

    #[test]
    fn cursor_shell_becomes_a_permission_request_without_the_email() {
        let (ev, out) = run(
            Format::Cursor,
            "beforeShellExecution",
            json!({ "conversation_id": "c1", "workspace_roots": ["C:/p"], "user_email": "a@b.c", "command": "rm -rf x", "hook_event_name": "beforeShellExecution" }),
        );
        assert_eq!(ev, "PermissionRequest");
        assert_eq!(out["session_id"], "c1");
        assert_eq!(out["cwd"], "C:/p");
        assert_eq!(out["tool_input"]["command"], "rm -rf x");
        assert_eq!(out["coucou_wait"], true);
        assert!(out.get("user_email").is_none() && out.get("command").is_none());
        assert_eq!(run(Format::Cursor, "stop", json!({ "status": "error" })).0, "StopFailure");
        assert_eq!(run(Format::Cursor, "stop", json!({ "status": "completed" })).0, "Stop");
        assert_eq!(run(Format::Cursor, "postToolUse", json!({})).0, "PostToolUse");
    }

    #[test]
    fn cursor_always_prints_valid_json_where_it_could_block() {
        let ask = r#"{"continue":true,"permission":"ask"}"#;
        // No pipe / internal / bad stdin (event unknown), timeout, no word: ask.
        assert_eq!(fallback(Format::Cursor, "").as_deref(), Some(ask));
        assert_eq!(fallback(Format::Cursor, "PermissionRequest").as_deref(), Some(ask));
        // Events that cannot block print nothing.
        assert!(fallback(Format::Cursor, "Stop").is_none());
        assert_eq!(reply(Format::Cursor, "allow").unwrap(), r#"{"continue":true,"permission":"allow"}"#);
        assert!(reply(Format::Cursor, "deny").unwrap().contains(r#""permission":"deny""#));
        // Anything but allow/deny is ask, never allow.
        for w in ["always", "", "x", "Allow"] {
            assert_eq!(reply(Format::Cursor, w).as_deref(), Some(ask), "{w}");
        }
        for s in [reply(Format::Cursor, "deny").unwrap(), ask.to_string()] {
            serde_json::from_str::<Value>(&s).unwrap();
        }
    }

    #[test]
    fn copilot_and_opencode_never_wait() {
        for f in [Format::Copilot, Format::Opencode, Format::Gemini] {
            let (_, out) = run(f, "PermissionRequest", json!({ "session_id": "s" }));
            assert!(out.get("coucou_wait").is_none());
            assert!(!waits(f, "PermissionRequest"));
        }
    }
}
