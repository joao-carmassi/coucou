// Installing and removing the hooks of the agents. Pure merge/unmerge on JSON values, plus
// preview/apply on top of core::cfgfile (backup, diff, fingerprint). Nothing is written without
// a preview the user clicked through; foreign keys and foreign hooks are kept as they are.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::catalog::{AgentDef, Kind, Style, COPILOT_EVENTS};
use crate::core::cfgfile;

const MARK: &str = "coucou-hook";
const CHANNEL: &str = "--channel agents";

/// Is this command line one of ours? (the relay's name AND our channel)
pub fn is_ours(command: &str) -> bool {
    command.contains(MARK) && command.contains(CHANNEL)
}

/// A file entirely ours is recognised by the relay's name and the channel word inside it.
fn own_text_is_ours(text: &str) -> bool {
    text.contains(MARK) && text.contains("agents")
}

pub fn command_line(exe: &str, id: &str) -> String {
    format!("{exe} {CHANNEL} --agent {id} --format {id}")
}

/// Safe bare in PowerShell, cmd and sh alike: only ASCII letters, digits and `\:._-~`.
fn is_plain(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_alphanumeric() || "\\:._-~".contains(c))
}

/// The relay's path as it goes into a command line: as it is when plain, else the 8.3 form of
/// its folder (the file name stays, so the marker keeps matching). No quoted fallback: quotes
/// break in PowerShell and `$ ` % are expanded, so without a plain path nothing is written.
pub fn exe_for_command(exe: &Path) -> Result<String, String> {
    let plain = exe.to_string_lossy().to_string();
    if is_plain(&plain) {
        return Ok(plain);
    }
    if let (Some(dir), Some(name)) = (exe.parent().and_then(short_dir), exe.file_name()) {
        let short = dir.join(name).to_string_lossy().to_string();
        if is_plain(&short) {
            return Ok(short);
        }
    }
    Err("O caminho do relay tem espaços ou caracteres especiais e o Windows não tem nome curto (8.3) para ele. Nada foi gravado: ative nomes curtos no volume ou mova a pasta de dados do Coucou.".into())
}

fn short_dir(dir: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    let n = unsafe { windows::Win32::Storage::FileSystem::GetShortPathNameW(windows::core::PCWSTR(wide.as_ptr()), Some(&mut buf)) } as usize;
    (n > 0 && n < buf.len()).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
}

// ── JSON merge ───────────────────────────────────────────────────────────────

fn entry_command(style: Style, e: &Value) -> impl Iterator<Item = &str> {
    let inner: Vec<&Value> = match style {
        Style::Nested { .. } => e.get("hooks").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default(),
        Style::Flat => vec![e],
    };
    inner.into_iter().filter_map(|h| h.get("command").and_then(Value::as_str))
}

/// The list without our hooks. In a nested entry only our hook goes; the entry goes when it empties.
fn strip(style: Style, list: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for e in list {
        match style {
            Style::Flat if entry_command(style, e).any(is_ours) => {}
            Style::Nested { .. } => {
                let inner = e.get("hooks").and_then(Value::as_array);
                let kept: Vec<Value> = inner
                    .map(|a| a.iter().filter(|h| !h.get("command").and_then(Value::as_str).is_some_and(is_ours)).cloned().collect())
                    .unwrap_or_default();
                match inner {
                    Some(a) if kept.len() != a.len() => {
                        if !kept.is_empty() {
                            let mut e = e.clone();
                            e["hooks"] = Value::Array(kept);
                            out.push(e);
                        }
                    }
                    _ => out.push(e.clone()),
                }
            }
            _ => out.push(e.clone()),
        }
    }
    out
}

fn hooks_of(existing: &Value) -> Result<Map<String, Value>, String> {
    match existing.get("hooks") {
        None => Ok(Map::new()),
        Some(Value::Object(m)) => Ok(m.clone()),
        Some(_) => Err("O campo \"hooks\" do arquivo não é um objeto — o Coucou não vai mexer nele.".into()),
    }
}

fn list_of(hooks: &Map<String, Value>, event: &str) -> Result<Vec<Value>, String> {
    match hooks.get(event) {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(_) => Err(format!("Os hooks de \"{event}\" não são uma lista — o Coucou não vai mexer neles.")),
    }
}

/// The file with our hooks added (replacing older ones of ours); everything else untouched.
pub fn merged(def: &AgentDef, existing: &Value, command: &str) -> Result<Value, String> {
    let Kind::JsonMerge { events, style, .. } = def.kind else { return Err("agente sem arquivo mesclável".into()) };
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = hooks_of(existing)?;
    for (event, timeout) in events {
        let mut list = strip(style, &list_of(&hooks, event)?);
        list.push(match style {
            Style::Nested { named } => {
                let mut h = json!({ "type": "command", "command": command, "timeout": timeout });
                if named {
                    h["name"] = json!("coucou");
                }
                json!({ "hooks": [h] })
            }
            Style::Flat => json!({ "command": command, "timeout": timeout }),
        });
        hooks.insert((*event).into(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    if matches!(style, Style::Flat) && !root.contains_key("version") {
        root.insert("version".into(), json!(1));
    }
    Ok(Value::Object(root))
}

/// The file with every hook of ours removed, and nothing else changed.
pub fn without_ours(def: &AgentDef, existing: &Value) -> Result<Value, String> {
    let Kind::JsonMerge { style, .. } = def.kind else { return Err("agente sem arquivo mesclável".into()) };
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = hooks_of(existing)?;
    let mut changed = false;
    for event in hooks.keys().cloned().collect::<Vec<_>>() {
        let Some(Value::Array(list)) = hooks.get(&event) else { continue };
        let kept = strip(style, list);
        if kept != *list {
            changed = true;
            if kept.is_empty() {
                hooks.remove(&event);
            } else {
                hooks.insert(event, Value::Array(kept));
            }
        }
    }
    if changed && hooks.is_empty() {
        root.remove("hooks");
    } else if changed {
        root.insert("hooks".into(), Value::Object(hooks));
    }
    Ok(Value::Object(root))
}

pub fn hooked_json(def: &AgentDef, existing: &Value) -> bool {
    let Kind::JsonMerge { style, .. } = def.kind else { return false };
    existing
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|h| h.values().filter_map(Value::as_array).flatten().any(|e| entry_command(style, e).any(is_ours)))
}

// ── Files that are entirely ours ─────────────────────────────────────────────

pub fn copilot_body(exe: &str, id: &str) -> String {
    let mut hooks = Map::new();
    for event in COPILOT_EVENTS {
        // exec + args: no shell, so no quoting to get wrong.
        hooks.insert(
            (*event).into(),
            json!([{ "type": "command", "exec": exe, "args": ["--channel", "agents", "--agent", id, "--format", id], "timeoutSec": 10 }]),
        );
    }
    let mut text = serde_json::to_string_pretty(&json!({ "version": 1, "hooks": hooks })).unwrap_or_default();
    text.push('\n');
    text
}

const OPENCODE_TEMPLATE: &str = r#"// Coucou: tells the island what OpenCode is doing (observe only). Written by Coucou
// (coucou-hook, channel agents); remove it from Coucou's settings, not by hand.
const EXE = __EXE__;
const send = (ev) => {
  try {
    Bun.spawn([EXE, "--channel", "agents", "--agent", "__ID__", "--format", "__ID__"], {
      stdin: new Response(JSON.stringify(ev)), stdout: "ignore", stderr: "ignore",
    });
  } catch {}
};
export const CoucouPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    try {
      const p = event.properties ?? {};
      const base = { session_id: p.sessionID ?? p.info?.id ?? "opencode", cwd: directory };
      if (event.type === "session.created") send({ ...base, hook_event_name: "SessionStart" });
      else if (event.type === "session.idle") send({ ...base, hook_event_name: "Stop" });
      else if (event.type === "session.error") send({ ...base, hook_event_name: "StopFailure" });
      else if (event.type === "permission.asked") send({ ...base, hook_event_name: "Notification", message: "Aprovação pendente?" });
    } catch {}
  },
  "tool.execute.before": async (input) => {
    try { send({ session_id: input.sessionID ?? "opencode", cwd: directory, hook_event_name: "PreToolUse", tool_name: input.tool }); } catch {}
  },
  "tool.execute.after": async (input) => {
    try { send({ session_id: input.sessionID ?? "opencode", cwd: directory, hook_event_name: "PostToolUse", tool_name: input.tool }); } catch {}
  },
});
"#;

/// A fixed template; the exe path is the only value put in, as a JSON (= JS) string.
pub fn opencode_body(exe: &str, id: &str) -> String {
    OPENCODE_TEMPLATE
        .replace("__EXE__", &serde_json::to_string(exe).unwrap_or_default())
        .replace("__ID__", id)
}

// ── Preview and apply ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes the diff was computed from; handed back to `apply`.
    pub fingerprint: String,
}

/// What the file is now and what it would become (None = the file goes).
struct Plan {
    path: PathBuf,
    before: String,
    after: Option<String>,
}

fn pretty(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap_or_default();
    s.push('\n');
    s
}

fn plan(def: &AgentDef, install: bool, exe: &Path) -> Result<Plan, String> {
    let path = def.path();
    match def.kind {
        Kind::JsonMerge { .. } => {
            let current = cfgfile::read_json_strict(&path)?;
            let next = if install { merged(def, &current, &command_line(&exe_for_command(exe)?, def.id))? } else { without_ours(def, &current)? };
            Ok(Plan { path, before: pretty(&current), after: Some(pretty(&next)) })
        }
        Kind::OwnFile { body, .. } => {
            let before = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(format!("Não consegui ler {}: {e}", path.display())),
            };
            if !before.is_empty() && !own_text_is_ours(&before) {
                return Err(format!("{} não foi escrito pelo Coucou — nada será alterado.", path.display()));
            }
            // Copilot's file holds the exe as a plain JSON string; opencode's too. Neither goes through a shell.
            let exe_plain = exe.to_string_lossy();
            Ok(Plan { path, before, after: install.then(|| body(&exe_plain, def.id)) })
        }
    }
}

pub fn preview(def: &AgentDef, install: bool, exe: &Path) -> Result<HookPreview, String> {
    let p = plan(def, install, exe)?;
    Ok(HookPreview {
        diff: cfgfile::unified_diff(&p.before, p.after.as_deref().unwrap_or("")),
        backup: cfgfile::backup_path(&p.path).to_string_lossy().to_string(),
        settings_path: p.path.to_string_lossy().to_string(),
        fingerprint: cfgfile::fingerprint_of(&p.path),
    })
}

/// Writes what the preview showed, if the file is still the one it was computed from.
pub fn apply(def: &AgentDef, install: bool, fingerprint: &str, exe: &Path) -> Result<String, String> {
    if install && !exe.exists() {
        return Err("O relay ainda não está instalado. Reinicie o Coucou.".into());
    }
    let p = plan(def, install, exe)?;
    match p.after {
        Some(text) => cfgfile::write_checked(&p.path, fingerprint, text.as_bytes()),
        None => cfgfile::remove_checked(&p.path, fingerprint),
    }
}

/// Is the agent's hook file ours? Never fails: an unreadable file is "not hooked".
pub fn hooked(def: &AgentDef) -> bool {
    match def.kind {
        Kind::JsonMerge { .. } => cfgfile::read_json_strict(&def.path()).is_ok_and(|v| hooked_json(def, &v)),
        Kind::OwnFile { .. } => std::fs::read_to_string(def.path()).is_ok_and(|t| own_text_is_ours(&t)),
    }
}

#[cfg(test)]
mod tests {
    use super::super::catalog::find;
    use super::*;

    const EXE: &str = r"C:\Users\a\AppData\Local\Coucou\bin\coucou-hook.exe";

    fn cmd(id: &str) -> String {
        command_line(EXE, id)
    }

    #[test]
    fn marker_needs_the_relay_and_the_channel() {
        assert!(is_ours(&cmd("codex")));
        assert!(!is_ours(r"C:\x\coucou-hook.exe Stop")); // claude's own entry
        assert!(!is_ours("node other.js --channel agents"));
    }

    #[test]
    fn codex_roundtrip_keeps_foreign_hooks() {
        let def = find("codex").unwrap();
        let foreign = json!({ "hooks": [{ "type": "command", "command": "my.sh" }] });
        let existing = json!({ "other": 1, "hooks": { "Stop": [foreign.clone()], "Custom": [foreign.clone()] } });
        let on = merged(def, &existing, &cmd("codex")).unwrap();
        assert_eq!(on["other"], 1);
        assert_eq!(on["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(on["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 120);
        assert!(hooked_json(def, &on));
        // Installing twice does not stack.
        assert_eq!(merged(def, &on, &cmd("codex")).unwrap(), on);
        let off = without_ours(def, &on).unwrap();
        assert_eq!(off, existing);
        assert!(!hooked_json(def, &off));
    }

    #[test]
    fn a_foreign_hook_sharing_our_entry_survives_removal() {
        let def = find("codex").unwrap();
        let shared = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": cmd("codex") }, { "type": "command", "command": "keep.sh" }] }] } });
        let off = without_ours(def, &shared).unwrap();
        assert_eq!(off["hooks"]["Stop"][0]["hooks"], json!([{ "type": "command", "command": "keep.sh" }]));
    }

    #[test]
    fn gemini_timeouts_are_ms_and_named() {
        let def = find("gemini").unwrap();
        let on = merged(def, &json!({ "theme": "dark" }), &cmd("gemini")).unwrap();
        let h = &on["hooks"]["BeforeTool"][0]["hooks"][0];
        assert_eq!((h["timeout"].as_u64(), h["name"].as_str()), (Some(10_000), Some("coucou")));
        assert_eq!(on["theme"], "dark");
        assert_eq!(without_ours(def, &on).unwrap(), json!({ "theme": "dark" }));
    }

    #[test]
    fn cursor_is_flat_and_keeps_its_version() {
        let def = find("cursor").unwrap();
        let existing = json!({ "version": 1, "hooks": { "stop": [{ "command": "mine.cmd" }] } });
        let on = merged(def, &existing, &cmd("cursor")).unwrap();
        assert_eq!(on["version"], 1);
        assert_eq!(on["hooks"]["beforeShellExecution"][0]["timeout"], 120);
        assert_eq!(on["hooks"]["stop"][0]["command"], "mine.cmd");
        assert!(on["hooks"].get("preToolUse").is_none() && on["hooks"].get("beforeSubmitPrompt").is_none());
        assert_eq!(merged(def, &json!({}), &cmd("cursor")).unwrap()["version"], 1);
        assert_eq!(without_ours(def, &on).unwrap(), existing);
    }

    #[test]
    fn an_odd_hooks_value_is_refused_not_overwritten() {
        let def = find("codex").unwrap();
        assert!(merged(def, &json!({ "hooks": [] }), &cmd("codex")).is_err());
        assert!(merged(def, &json!({ "hooks": { "Stop": "x" } }), &cmd("codex")).is_err());
        assert!(without_ours(def, &json!({ "hooks": 3 })).is_err());
    }

    #[test]
    fn approval_flags_follow_the_verified_hooks() {
        let blocking: Vec<_> = super::super::catalog::AGENTS.iter().filter(|a| a.blocking).map(|a| a.id).collect();
        assert_eq!(blocking, ["codex", "cursor"]);
        // A non-blocking agent never gets the event that waits.
        let Kind::JsonMerge { events, .. } = find("gemini").unwrap().kind else { panic!() };
        assert!(events.iter().all(|(e, _)| *e != "PermissionRequest"));
        assert!(!COPILOT_EVENTS.contains(&"PermissionRequest") && !COPILOT_EVENTS.contains(&"PreToolUse"));
    }

    #[test]
    fn own_files_carry_the_exe_escaped() {
        let weird = r#"C:\Users\a"b\coucou-hook.exe"#;
        let js = opencode_body(weird, "opencode");
        assert!(js.contains(r#"const EXE = "C:\\Users\\a\"b\\coucou-hook.exe";"#));
        assert!(js.contains("\"--agent\", \"opencode\"") && !js.contains("__"));
        assert!(own_text_is_ours(&js));
        let v: Value = serde_json::from_str(&copilot_body(weird, "copilot")).unwrap();
        assert_eq!(v["hooks"]["Stop"][0]["exec"], weird);
        assert_eq!(v["hooks"]["Stop"][0]["args"][1], "agents");
        assert!(v["hooks"].get("PermissionRequest").is_none());
        assert!(own_text_is_ours(&copilot_body(weird, "copilot")));
    }

    #[test]
    fn a_path_with_spaces_is_not_left_bare() {
        assert!(is_plain(EXE));
        for bad in [r"C:\Users\João Vitor\x.exe", r"C:\a$b\x.exe", r"C:\a`b\x.exe", r"C:\100%\x.exe", "C:\\a'b\\x.exe", r"C:\a{b}\x.exe", r"C:\a=b\x.exe"] {
            assert!(!is_plain(bad), "{bad}");
        }
        // No short name and not plain: refused, never quoted.
        let err = exe_for_command(Path::new(r"Z:\no such dir\coucou-hook.exe")).unwrap_err();
        assert!(err.contains("Nada foi gravado"));
        assert_eq!(exe_for_command(Path::new(EXE)).unwrap(), EXE);
    }
}
