// Sends one fake Claude Code hook event to Coucou's pipe, the way coucou-hook does, so island pills can be tested without Claude.
// Usage: node scripts/fake-agent.mjs <Event> [--session <id>] [--cwd <dir>] [--tool <name>] [--agent <name>] [--message <text>] [--wait]
//   Events: SessionStart, PreToolUse, Notification, Stop. PermissionRequest only with --wait (it waits for the island's reply line).
// Exits 0 quietly when the pipe is absent (Coucou is closed), like the hook.
import { execFileSync } from "node:child_process";
import net from "node:net";
import { join } from "node:path";

const EVENTS = ["SessionStart", "PreToolUse", "Notification", "Stop", "PermissionRequest"];
const WAIT_TIMEOUT_MS = 120_000; // the hook gives up on a permission answer after 110 s

function usage(msg) {
  console.error(`fake-agent: ${msg}\nusage: node scripts/fake-agent.mjs <${EVENTS.join("|")}> [--session <id>] [--cwd <dir>] [--tool <name>] [--agent <name>] [--message <text>] [--wait]`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { session: "fake-session", cwd: process.cwd(), tool: null, agent: null, message: null, wait: false };
let event = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--wait") opts.wait = true;
  else if (["--session", "--cwd", "--tool", "--agent", "--message"].includes(a)) {
    if (argv[i + 1] === undefined) usage(`${a} needs a value`);
    opts[a.slice(2)] = argv[++i];
  } else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else if (event === null) event = a;
  else usage(`unexpected argument ${a}`);
}
if (!event || !EVENTS.includes(event)) usage(`event must be one of ${EVENTS.join(", ")}`);
if (event === "PermissionRequest" && !opts.wait) usage("PermissionRequest waits for an answer: pass --wait");
if (opts.wait && event !== "PermissionRequest") usage("--wait only applies to PermissionRequest");

// The pipe name is \\.\pipe\coucou-<user SID>, read the way hook/src/win.rs does (falls back to the user name).
function userKey() {
  try {
    // Full path: a POSIX whoami (Git for Windows) earlier on PATH would not take /user.
    const exe = join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
    const out = execFileSync(exe, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const sid = out.match(/S-1-\d+(?:-\d+)+/);
    if (sid) return sid[0];
  } catch {
    // not Windows, or whoami missing: fall through to the user name
  }
  return process.env.USERNAME || process.env.USER || "user";
}
const pipe = `\\\\.\\pipe\\coucou-${userKey()}`;

const payload = { hook_event_name: event, session_id: opts.session, cwd: opts.cwd };
if (opts.tool) payload.tool_name = opts.tool;
if (opts.tool && event !== "SessionStart") payload.tool_input = {};
if (opts.agent) payload.coucou_agent = opts.agent;
if (opts.message) {
  if (event === "Stop") payload.last_message = opts.message;
  else payload.message = opts.message;
}
const line = `${JSON.stringify(payload)}\n`;

const socket = net.connect(pipe);
let buf = "";
if (opts.wait) socket.setTimeout(WAIT_TIMEOUT_MS, () => {
  console.error("fake-agent: no answer from Coucou in time");
  process.exit(1);
});
socket.on("error", (err) => {
  if (err.code === "ENOENT" || err.code === "ECONNREFUSED") process.exit(0); // Coucou is not running
  console.error(`fake-agent: ${err.message}`);
  process.exit(1);
});
socket.on("connect", () => {
  if (!opts.wait) {
    socket.end(line, () => process.exit(0)); // fire and forget: the hook never waits here
    return;
  }
  socket.write(line);
});
socket.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  if (buf.includes("\n")) {
    process.stdout.write(buf.slice(0, buf.indexOf("\n")).trim() + "\n");
    socket.destroy();
    process.exit(0);
  }
});
socket.on("end", () => process.exit(0));
socket.on("close", () => process.exit(0));
