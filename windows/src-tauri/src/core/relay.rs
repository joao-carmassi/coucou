// Local relay: a named pipe `\\.\pipe\coucou-<sid>` shared by every module that
// talks to a helper executable. A message names its channel (`coucou_channel`;
// absent = ""); the subscriber of that channel gets it.
//
// A channel that `waits` keeps its connection open: the sender stays blocked
// until the island says something, and the one-line reply goes back on the same
// connection. The sender is never blocked by us for long:
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen (ACK_TIMEOUT), so a paused island costs a few hundred milliseconds;
//   * whatever happens we drop the connection after DECISION_TIMEOUT, and the
//     terminal takes over (no reply = the sender prints nothing).
//
// The pipe exists only while somebody is subscribed. Payloads are never logged.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::core::host::ModuleCtx;
use crate::core::log;

/// Slightly under the sender's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up".
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;
const MAX_REPLY: usize = 64 * 1024;

#[derive(Clone, Copy)]
pub struct Channel {
    /// `[a-z0-9-]{1,24}`; "" = messages naming no channel.
    pub name: &'static str,
    /// Does the sender wait for a reply? (then `request_id` is stamped)
    pub waits: fn(&Value) -> bool,
    /// Must return fast.
    pub deliver: fn(&AppHandle, Value),
}

enum Reply {
    Ack,
    Decision(String),
    Decline,
}

/// request id -> (channel name, sender of what the island says)
type PendingMap = HashMap<String, (String, mpsc::Sender<Reply>)>;

static SUBS: Mutex<Vec<Channel>> = Mutex::new(Vec::new());
static PENDING: Mutex<Option<PendingMap>> = Mutex::new(None);
static LOOP: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
static COUNTER: AtomicU64 = AtomicU64::new(1);

fn pending() -> MutexGuard<'static, Option<PendingMap>> {
    let mut g = PENDING.lock().unwrap();
    g.get_or_insert_with(HashMap::new);
    g
}

/// `\\.\pipe\coucou-<sid>`: must match the helper's `pipe_path()` exactly.
pub fn pipe_name() -> String {
    let key = crate::core::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\coucou-{key}")
}

/// The channel a message names: missing -> "", invalid / not a string -> None (dropped).
fn channel_of(v: &Value) -> Option<&str> {
    match v.get("coucou_channel") {
        None => Some(""),
        Some(Value::String(s))
            if s.len() <= 24 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
        {
            Some(s)
        }
        _ => None,
    }
}

/// First line of the buffer, as a JSON object.
fn parse_line(buf: &[u8]) -> Option<Value> {
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => buf,
    };
    if line.len() > MAX_PAYLOAD {
        return None;
    }
    serde_json::from_slice::<Value>(line).ok().filter(Value::is_object)
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_reply(rx: &mut mpsc::Receiver<Reply>, ack: Duration, decide: Duration) -> Option<String> {
    match tokio::time::timeout(ack, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => return Some(d),
        Ok(Some(Reply::Decline)) | Ok(None) | Err(_) => return None,
    }
    match tokio::time::timeout(decide, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => Some(d),
        _ => None,
    }
}

/// Forgets every pending request of a channel; their waiting connections end without a reply.
fn drop_channel(map: &mut PendingMap, name: &str) {
    map.retain(|_, (ch, _)| ch != name);
}

fn check_reply(line: &str) -> Result<(), String> {
    if line.contains('\n') || line.len() > MAX_REPLY {
        return Err("a reply is one line of at most 64 KiB".into());
    }
    Ok(())
}

/// The first word of a reply, never what follows.
fn word(reply: &str) -> &str {
    reply.split(' ').next().unwrap_or_default()
}

/// One accepted connection, whatever carries it.
trait Conn: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
}

impl Conn for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
}

#[cfg(test)]
impl Conn for tokio::io::DuplexStream {}

async fn serve(
    mut conn: impl Conn,
    find: impl Fn(&str) -> Option<Channel>,
    deliver: impl Fn(Channel, Value),
    ack: Duration,
    decide: Duration,
) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match conn.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let Some(mut payload) = parse_line(&buf) else { return };
    let Some(name) = channel_of(&payload).map(str::to_string) else { return };
    let Some(ch) = find(&name) else {
        conn.finish();
        return;
    };

    if !(ch.waits)(&payload) {
        deliver(ch, payload);
        conn.finish();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    pending().as_mut().unwrap().insert(id.clone(), (name.clone(), tx));
    payload["request_id"] = json!(id);
    deliver(ch, payload);

    let decision = wait_reply(&mut rx, ack, decide).await;
    pending().as_mut().unwrap().remove(&id);
    log::line(format!("relay ch={name} id={id} {}", decision.as_deref().map(word).unwrap_or("none")));

    // No decision: say nothing at all, the sender then prints nothing.
    if let Some(d) = decision {
        let _ = conn.write_all(format!("{d}\n").as_bytes()).await;
        let _ = conn.flush().await;
    }
    conn.finish();
}

fn find(name: &str) -> Option<Channel> {
    SUBS.lock().unwrap().iter().find(|c| c.name == name).copied()
}

async fn accept_loop(app: AppHandle) {
    let name = pipe_name();
    // first_pipe_instance: refuse to serve on a pipe somebody else owns.
    // Retry: after a stop/start the previous instance may take a moment to close.
    let mut tries = 0;
    let mut server = loop {
        match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => break s,
            Err(_) if tries < 50 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        }
    };
    loop {
        if server.connect().await.is_err() {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        // Hand the connected instance to a task and listen on a fresh one.
        let next = match ServerOptions::new().create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot reopen the relay pipe: {err}"));
                return;
            }
        };
        let connected = std::mem::replace(&mut server, next);
        let app = app.clone();
        tauri::async_runtime::spawn(serve(
            connected,
            find,
            move |ch, v| (ch.deliver)(&app, v),
            ACK_TIMEOUT,
            DECISION_TIMEOUT,
        ));
    }
}

/// Takes `ch.name`; the first subscriber opens the pipe, the last one closes it.
/// False if the name is taken. Unsubscribes by itself when the module stops.
pub fn subscribe(ctx: &ModuleCtx, ch: Channel) -> bool {
    {
        let mut subs = SUBS.lock().unwrap();
        if subs.iter().any(|c| c.name == ch.name) {
            return false;
        }
        subs.push(ch);
        let mut lp = LOOP.lock().unwrap();
        if lp.is_none() {
            *lp = Some(tauri::async_runtime::spawn(accept_loop(ctx.app.clone())));
        }
    }
    let name = ch.name;
    ctx.on_stop(move || {
        let mut subs = SUBS.lock().unwrap();
        subs.retain(|c| c.name != name);
        if let Some(map) = pending().as_mut() {
            drop_channel(map, name);
        }
        if subs.is_empty() {
            if let Some(h) = LOOP.lock().unwrap().take() {
                h.abort();
            }
        }
    });
    true
}

fn send(request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let mut g = pending();
        let map = g.as_mut().unwrap();
        if keep {
            map.get(request_id).map(|(_, tx)| tx.clone())
        } else {
            map.remove(request_id).map(|(_, tx)| tx)
        }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("relay id={request_id} no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn ack(_app: &AppHandle, request_id: &str) {
    send(request_id, Reply::Ack, true);
}

/// Nobody can act on this one: the sender falls back at once.
pub fn decline(_app: &AppHandle, request_id: &str) {
    log::line(format!("relay decline id={request_id}"));
    send(request_id, Reply::Decline, false);
}

/// One line, no '\n', at most 64 KiB.
pub fn reply(_app: &AppHandle, request_id: &str, line: &str) -> Result<(), String> {
    check_reply(line)?;
    send(request_id, Reply::Decision(line.to_string()), false);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn channel_of_cases() {
        assert_eq!(channel_of(&json!({})), Some(""));
        assert_eq!(channel_of(&json!({"coucou_channel": "agents"})), Some("agents"));
        assert_eq!(channel_of(&json!({"coucou_channel": "a-1"})), Some("a-1"));
        assert_eq!(channel_of(&json!({"coucou_channel": "Bad"})), None);
        assert_eq!(channel_of(&json!({"coucou_channel": "a_b"})), None);
        assert_eq!(channel_of(&json!({"coucou_channel": "x".repeat(25)})), None);
        assert_eq!(channel_of(&json!({"coucou_channel": 5})), None);
    }

    #[test]
    fn parse_line_cases() {
        assert_eq!(parse_line(b"{\"a\":1}\nrest"), Some(json!({"a": 1})));
        assert_eq!(parse_line(b"{\"a\":1}"), Some(json!({"a": 1})));
        assert!(parse_line(b"[1]\n").is_none());
        assert!(parse_line(b"nope\n").is_none());
        assert!(parse_line(&vec![b'x'; MAX_PAYLOAD + 1]).is_none());
    }

    #[test]
    fn wait_reply_variants() {
        run(async {
            let (tx, mut rx) = mpsc::channel(4);
            tx.send(Reply::Ack).await.unwrap();
            tx.send(Reply::Decision("allow".into())).await.unwrap();
            assert_eq!(wait_reply(&mut rx, 50 * MS, 50 * MS).await.as_deref(), Some("allow"));

            let (tx, mut rx) = mpsc::channel(4);
            tx.send(Reply::Decision("deny".into())).await.unwrap();
            assert_eq!(wait_reply(&mut rx, 50 * MS, 50 * MS).await.as_deref(), Some("deny"));

            let (tx, mut rx) = mpsc::channel(4);
            tx.send(Reply::Decline).await.unwrap();
            assert_eq!(wait_reply(&mut rx, 50 * MS, 50 * MS).await, None);

            let (_tx, mut rx) = mpsc::channel::<Reply>(4);
            assert_eq!(wait_reply(&mut rx, 20 * MS, 50 * MS).await, None); // ack timeout

            let (tx, mut rx) = mpsc::channel(4);
            tx.send(Reply::Ack).await.unwrap();
            let t = std::time::Instant::now();
            assert_eq!(wait_reply(&mut rx, 50 * MS, 30 * MS).await, None); // decide timeout
            assert!(t.elapsed() >= 30 * MS);

            let (tx, mut rx) = mpsc::channel(4);
            tx.send(Reply::Ack).await.unwrap();
            drop(tx);
            assert_eq!(wait_reply(&mut rx, 50 * MS, 50 * MS).await, None); // sender dropped
        });
    }

    #[test]
    fn drop_channel_keeps_others() {
        let mut m: PendingMap = HashMap::new();
        let (a, _ra) = mpsc::channel(1);
        let (b, _rb) = mpsc::channel(1);
        m.insert("1".into(), ("x".into(), a));
        m.insert("2".into(), ("y".into(), b));
        drop_channel(&mut m, "x");
        assert!(m.contains_key("2") && !m.contains_key("1"));
    }

    #[test]
    fn reply_refuses_newline_and_long_lines() {
        assert!(check_reply("allow").is_ok());
        assert!(check_reply("a\nb").is_err());
        assert!(check_reply(&"x".repeat(MAX_REPLY + 1)).is_err());
    }

    // Whole request/reply over an in-memory stream with a test channel.
    #[test]
    fn serve_roundtrip_and_routing() {
        fn waits(v: &Value) -> bool {
            v["w"] == true
        }
        fn nop(_: &AppHandle, _: Value) {}
        let ch = Channel { name: "tst", waits, deliver: nop };
        let find = move |n: &str| (n == "tst").then_some(ch);
        run(async move {
            use std::sync::{Arc, Mutex as M};
            let seen: Arc<M<Vec<Value>>> = Arc::default();

            // waiting request, answered through the pending table like ack/reply do
            let (mut client, server) = tokio::io::duplex(8192);
            let s2 = seen.clone();
            let task = tokio::spawn(serve(
                server,
                find,
                move |_, v| s2.lock().unwrap().push(v),
                Duration::from_secs(2),
                Duration::from_secs(2),
            ));
            client.write_all(b"{\"coucou_channel\":\"tst\",\"w\":true}\n").await.unwrap();
            let id = loop {
                tokio::time::sleep(5 * MS).await;
                if let Some(v) = seen.lock().unwrap().first() {
                    break v["request_id"].as_str().unwrap().to_string();
                }
            };
            send(&id, Reply::Ack, true);
            send(&id, Reply::Decision("allow".into()), false);
            let mut out = String::new();
            client.read_to_string(&mut out).await.unwrap();
            assert_eq!(out, "allow\n");
            task.await.unwrap();

            // non-waiting: delivered, no reply
            let (mut client, server) = tokio::io::duplex(8192);
            let n0 = seen.lock().unwrap().len();
            let s2 = seen.clone();
            let task = tokio::spawn(serve(server, find, move |_, v| s2.lock().unwrap().push(v), 50 * MS, 50 * MS));
            client.write_all(b"{\"coucou_channel\":\"tst\"}\n").await.unwrap();
            let mut out = String::new();
            client.read_to_string(&mut out).await.unwrap();
            task.await.unwrap();
            assert!(out.is_empty());
            assert_eq!(seen.lock().unwrap().len(), n0 + 1);

            // unknown channel: nothing delivered
            let (mut client, server) = tokio::io::duplex(8192);
            let s2 = seen.clone();
            let task = tokio::spawn(serve(server, find, move |_, v| s2.lock().unwrap().push(v), 50 * MS, 50 * MS));
            client.write_all(b"{\"coucou_channel\":\"other\"}\n").await.unwrap();
            task.await.unwrap();
            assert_eq!(seen.lock().unwrap().len(), n0 + 1);
        });
    }
}
