// herdr (a terminal workspace manager for agents): a session in one of its panes runs under the headless
// `herdr.exe server`, so its process chain never reaches a window. The window is the herdr client's (a TUI
// in a Windows Terminal tab), found by its console like any other terminal; herdr's socket API
// (newline-delimited JSON on a named pipe) says which pane holds the session and focuses it.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, PeekNamedPipe};

use super::focus;

/// Each answer must come within this; past it the click does what it can without.
const ANSWER: Duration = Duration::from_millis(250);
/// A busy pipe is retried for this long.
const BUSY: Duration = Duration::from_millis(300);
const ERROR_PIPE_BUSY: i32 = 231;

/// `\\.\pipe\<socket>` for an absolute socket path (HERDR_SOCKET_PATH). The path on disk is a plain file:
/// it is never opened itself.
fn pipe_path(socket: &str) -> Option<String> {
    let p = std::path::Path::new(socket);
    let clean = p.is_absolute() && !p.components().any(|c| matches!(c, std::path::Component::ParentDir));
    clean.then(|| format!(r"\\.\pipe\{socket}"))
}

/// Connects to herdr's pipe, only when its server is one of the session's ancestors (`pids`). Checked before
/// anything is sent: a stale HERDR_* variable or someone else's pipe gets nothing. Also gives the server's pid.
fn open(pipe: &str, pids: &[u32]) -> Option<(File, u32)> {
    let start = Instant::now();
    let file = loop {
        match OpenOptions::new().read(true).write(true).open(pipe) {
            Ok(f) => break f,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && start.elapsed() < BUSY => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return None,
        }
    };
    let mut server = 0u32;
    unsafe { GetNamedPipeServerProcessId(HANDLE(file.as_raw_handle()), &mut server) }.ok()?;
    pids.contains(&server).then_some((file, server))
}

/// One request on its own connection: the answer's `result` and the server's pid, or None on an error or past ANSWER.
fn call(pipe: &str, pids: &[u32], method: &str, params: Value) -> Option<(Value, u32)> {
    let (mut file, server) = open(pipe, pids)?;
    let line = json!({ "id": "coucou", "method": method, "params": params }).to_string() + "\n";
    file.write_all(line.as_bytes()).ok()?;
    let start = Instant::now();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        // Every complete line: ours is the one with our id.
        while let Some(end) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=end).collect();
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                if v.get("id").and_then(Value::as_str) == Some("coucou") {
                    return v.get("result").cloned().map(|r| (r, server));
                }
            }
        }
        let mut avail = 0u32;
        unsafe { PeekNamedPipe(HANDLE(file.as_raw_handle()), None, 0, None, Some(&mut avail), None) }.ok()?;
        if avail == 0 {
            if start.elapsed() > ANSWER {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let mut chunk = vec![0u8; avail as usize];
        let n = file.read(&mut chunk).ok()?;
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// The pane holding the session, from `pane.list`'s result: the one herdr knows by the session id (that
/// survives a move to another workspace, which renumbers the pane), else the hook's pane if still listed.
fn pick_pane<'a>(list: &'a Value, session_id: &str, hook_pane: &str) -> Option<&'a Value> {
    let panes = list.get("panes")?.as_array()?;
    let field = |p: &'a Value, ptr: &str| p.pointer(ptr).and_then(Value::as_str);
    let find = |ptr: &str, want: &str| (!want.is_empty()).then(|| panes.iter().find(|p| field(p, ptr) == Some(want))).flatten();
    find("/agent_session/value", session_id).or_else(|| find("/pane_id", hook_pane))
}

/// Brings a herdr session forward: the herdr client's window and tab first (by its console title, before the
/// focus change renames the tab), then herdr's own focus on the session's pane. None when herdr cannot be
/// reached or does not host this session: the plain focus runs. Some(false): herdr hosts it but no client
/// window was found, and no new terminal is opened over it.
// shortcut: with several herdr clients the first one with a visible window comes forward, and herdr may move the
// pane in another one; upgrade when that setup shows up.
pub fn focus(socket: &str, hook_pane: &str, session_id: &str, pids: &[u32]) -> Option<bool> {
    let pipe = pipe_path(socket)?;
    let (list, server) = call(&pipe, pids, "pane.list", json!({}))?;
    // Every herdr.exe but the server is a client. A client that started the server is its parent, so it is one
    // of the session's ancestors too: only the server's pid is left out.
    let clients: Vec<u32> = focus::pids_named("herdr.exe").into_iter().filter(|p| *p != server).collect();
    let raised = focus::existing_terminal(&clients, None, None);
    if let Some(pane) = pick_pane(&list, session_id, hook_pane) {
        let id = |k: &str| pane.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        // A pane herdr does not take for an agent: its workspace, then its tab.
        if call(&pipe, pids, "agent.focus", json!({ "target": id("pane_id") })).is_none() {
            let _ = call(&pipe, pids, "workspace.focus", json!({ "workspace_id": id("workspace_id") }));
            let _ = call(&pipe, pids, "tab.focus", json!({ "tab_id": id("tab_id") }));
        }
    }
    Some(raised)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from a real `herdr pane list` (herdr 0.9.5).
    fn list() -> Value {
        json!({ "panes": [
            { "pane_id": "w5:pZ", "tab_id": "w5:tH", "workspace_id": "w5",
              "agent_session": { "agent": "claude", "kind": "id", "value": "67d3c72e" } },
            { "pane_id": "w6:p1", "tab_id": "w6:t1", "workspace_id": "w6",
              "agent_session": { "agent": "claude", "kind": "id", "value": "e92656bf" } },
            { "pane_id": "w7:p1", "tab_id": "w7:t1", "workspace_id": "w7", "agent": "claude" }
        ], "type": "pane_list" })
    }
    fn pane(l: &Value, sid: &str, hook: &str) -> Option<String> {
        pick_pane(l, sid, hook).and_then(|p| p["pane_id"].as_str()).map(str::to_string)
    }

    #[test]
    fn session_id_beats_the_hook_pane() {
        let l = list();
        assert_eq!(pane(&l, "e92656bf", "w5:pZ").as_deref(), Some("w6:p1"), "a moved pane is found by its session");
        assert_eq!(pane(&l, "unknown", "w7:p1").as_deref(), Some("w7:p1"), "no session id known: the hook's pane");
        assert_eq!(pane(&l, "", "w7:p1").as_deref(), Some("w7:p1"));
        assert_eq!(pane(&l, "unknown", "w9:p9"), None, "a pane herdr no longer lists");
        assert_eq!(pane(&l, "", ""), None, "an empty id never matches a pane without one");
        assert_eq!(pane(&json!({}), "67d3c72e", "w5:pZ"), None);
    }

    #[test]
    fn pipe_path_only_for_an_absolute_socket() {
        assert_eq!(
            pipe_path(r"C:\Users\u\AppData\Roaming\herdr\herdr.sock").as_deref(),
            Some(r"\\.\pipe\C:\Users\u\AppData\Roaming\herdr\herdr.sock")
        );
        assert_eq!(pipe_path("herdr.sock"), None);
        assert_eq!(pipe_path(""), None);
        assert_eq!(pipe_path(r"C:\Users\u\..\x\herdr.sock"), None);
    }
}
