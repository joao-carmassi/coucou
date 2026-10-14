// Static idle audit: "island hidden + idle = ~zero resources; a disabled module creates nothing".
// Scans src/modules/** (TS) and src-tauri/src/modules/** (Rust). Exit 1 on any non-allowlisted finding.
// Run: npm run idle-audit
//
// TS rules (inside modules):
//   - setInterval/setTimeout/requestAnimationFrame must go through api.timeout / api.interval
//     (scoped to the module, cancelled on stop). Lines already using `api.` are fine.
//   - addEventListener at brace depth 0 (module top level) is forbidden: attach inside start()/views.
// Rust rules: thread::spawn, async_runtime::spawn, spawn_blocking, thread::Builder must go through
//   ctx.spawn / ctx.spawn_async / ctx.adopt (core/host.rs, core/hotkeys.rs, core/island.rs own raw calls
//   and are not scanned).
//
// ALLOWLIST: [file suffix, substring of the offending line, reason]. Keep each entry justified.
// Scans src/modules/** (TS) and src-tauri/src/modules/** (Rust). Exit 1 on any non-allowlisted finding.
// Run: npm run idle-audit
//
// TS rules (inside modules):
//   - setInterval/setTimeout/requestAnimationFrame must go through api.timeout / api.interval
//     (they are scoped to the module and cancelled on stop). Lines already using `api.` are fine.
//   - addEventListener at brace depth 0 (module top level) is forbidden: attach inside start()/views.
// Rust rules: thread::spawn, async_runtime::spawn, spawn_blocking, thread::Builder must go through
//   ctx.spawn / ctx.spawn_async / ctx.adopt (core/host.rs owns the raw calls).
//
// ALLOWLIST: [file suffix, substring of the offending line, reason]. Keep each entry justified.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const ALLOWLIST = [
  ["modules/claude/settings.ts", "window.setTimeout(ops.done", "settings panel: 2.6 s UI feedback after a user click; panel only exists while open"],
  ["modules/voice/settings.ts", "setTimeout(() => void refresh()", "settings panel: one-shot refresh 300 ms after a user save; panel only exists while open"],
  ["modules/claude/pipe.rs", "async_runtime::spawn(async move {", "accept loop: handle returned to mod.rs and registered via ctx.adopt; blocked on pipe accept"],
  ["modules/claude/pipe.rs", "spawn(async move { handle(", "per-connection handler: finishes with the connection, parked in I/O otherwise"],
  ["modules/integrations/scheduler.rs", "async_runtime::spawn(run(", "refcounted scheduler service shared by provider modules; exists only while >=1 provider is on"],
  ["modules/media/media.rs", "std::thread::spawn(move || settle_and_add", "on-demand settle thread: short-lived (file settle wait), ends by itself or on stop flag"],
  ["modules/voice/voice.rs", "std::thread::spawn(move || {", "recorder reader thread: lives only while recording, ends with the child process"],
];

const files = (dir, ext) => {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.some((e) => n.endsWith(e))) out.push(p);
  }
  return out;
};
const rel = (p) => relative(root, p).split(sep).join("/");
const allowed = (file, line) => ALLOWLIST.find(([f, s]) => file.endsWith(f) && line.includes(s));

const findings = [];
const add = (file, n, rule, line, reason) => findings.push({ file, n, rule, line: line.trim().slice(0, 70), reason });

const tsTimer = /\b(setInterval|setTimeout|requestAnimationFrame)\s*\(/;
for (const f of files(join(root, "src/modules"), [".ts"])) {
  const lines = readFileSync(f, "utf8").split("\n");
  let depth = 0, block = false;
  lines.forEach((raw, i) => {
    let l = raw;
    if (block) { const e = l.indexOf("*/"); if (e < 0) return; l = l.slice(e + 2); block = false; }
    l = l.replace(/\/\*.*?\*\//g, "");
    if (l.includes("/*")) { block = true; l = l.slice(0, l.indexOf("/*")); }
    const code = l.replace(/\/\/.*$/, "").replace(/(["'`])(?:\.|(?!\1).)*\1/g, '""');
    const name = rel(f);
    const topLevel = depth === 0 && /\baddEventListener\s*\(/.test(code);
    const timer = tsTimer.test(code) && !/\bapi\.(timeout|interval)\(/.test(code);
    if (timer || topLevel) {
      const al = allowed(name, raw);
      add(name, i + 1, timer ? "raw timer" : "top-level listener", raw, al ? al[2] : null);
    }
    for (const c of code) { if (c === "{") depth++; else if (c === "}") depth--; }
  });
}

const rsSpawn = /\b(thread::spawn|async_runtime::spawn|spawn_blocking|thread::Builder)\b/;
for (const f of files(join(root, "src-tauri/src/modules"), [".rs"])) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, "");
    if (!rsSpawn.test(code)) return;
    const name = rel(f);
    const al = allowed(name, raw);
    add(name, i + 1, "raw spawn", raw, al ? al[2] : null);
  });
}

console.log("file:line".padEnd(46) + "rule".padEnd(20) + "status");
for (const x of findings)
  console.log(`${x.file}:${x.n}`.padEnd(46) + x.rule.padEnd(20) + (x.reason ? `allowed - ${x.reason}` : "FAIL  " + x.line));
const bad = findings.filter((x) => !x.reason);
console.log(`\n${findings.length} finding(s), ${bad.length} not allowlisted`);
process.exit(bad.length ? 1 : 0);
