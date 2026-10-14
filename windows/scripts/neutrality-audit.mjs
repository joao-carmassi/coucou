// Static neutrality audit: "the core (island + Mochi) knows no module".
// Scope: src/{core,island,views,mochi,settings,style,kit}/**, src/main.ts, src-tauri/src/core/**, src-tauri/src/lib.rs.
// FAIL by default: exit 1 on any non-allowlisted finding, comment-only hits included.
// `--warn` prints everything and exits 0 (comment hits shown as warnings).
// Run: npm run neutrality-audit [-- --warn] [-- --verbose]
//
// LINTS (behavioural; FAIL by default when a count is above scripts/neutrality-ratchet.json; `--warn-lints` only prints):
//   A. boundary: src/modules/** must not import `State` (value import from core/state), write `State.<field> =`, or
//      value-import core other than core/moduleApi, kit/* (`import type` is always fine).
//   B. dead fields: every field of Settings, AppState, ViewLayout and IslandApi must be READ in src/{core,island,views,mochi}
//      (IslandApi: used by any src file but moduleApi.ts/registry.ts, since modules are its readers).
// scripts/neutrality-ratchet.json holds the counts; they may only go down (`--write-ratchet` lowers them).
//
// Rules:
//   1. TS import path containing `/modules/` (core/registry.ts and settings/main.ts may import modules/settings + catalog).
//   2. Module id / label / group (derived from src/modules/* folders and their manifest.json) as a whole word in code
//      (comment hits carry the rule suffix "(comment)" and fail too).
//   3. Concept denylist (approval, session, overview, ...) in code or comments.
//   4. CSS: a selector of a core sheet (src/style, src/settings) must not use a module's class prefix (gh-, sess-, int-, ...).
//      Prefixes come from the selectors of src/modules/*/*.css that no core sheet defines and that only ONE module uses
//      (a prefix two modules share is the shared kit's: pane-, diff-). Allowlist a hit with a reason.
//   5. Rust: `modules::` outside CATALOG/registry/handler lines; events emitted by core must be generic;
//      `#[cfg(test)]` blocks are skipped.
//
// ALLOWLIST: [file suffix, substring of the offending line, reason]. Keep each entry justified.
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const fail = !process.argv.includes("--warn");
const failLints = !process.argv.includes("--warn-lints") && !process.argv.includes("--warn");

const ALLOWLIST = [
  ["src/core/registry.ts", "modules/index", "the only core file that loads the module list"],
  ["src/core/registry.ts", "modules/catalog", "registry reads the catalog"],
  ["src/settings/main.ts", "modules/settings", "settings window loads the sections only (no island code or CSS)"],
  ["src/settings/main.ts", "modules/catalog", "settings window lists the modules"],
  ["src-tauri/src/core/drop_target.rs", "self.emit(", "generic enter/leave/drop of the OS drag, relayed as `file-drag`: not module events"],
];
const CORE_EVENTS = ["cursor", "tray", "screen-changed", "settings-changed", "settings-shown", "modules-changed", "file-drag", "hotkey-error", "inbox-added"];
const CONCEPTS = ["approval", "session", "overview", "github", "wsl", "transcript", "claude", "voice", "media"];

const files = (dir, ext) => {
  if (!existsSync(dir)) return [];
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

// Names: folder ids + ids/labels/groups from the manifests.
const moduleDirs = readdirSync(join(root, "src/modules")).filter((n) => statSync(join(root, "src/modules", n)).isDirectory());
const names = new Set(readdirSync(join(root, "src/modules")).filter((n) => statSync(join(root, "src/modules", n)).isDirectory()));
for (const n of [...names]) {
  const f = join(root, "src/modules", n, "manifest.json");
  if (!existsSync(f)) continue;
  for (const m of [JSON.parse(readFileSync(f, "utf8"))].flat()) for (const k of ["id", "label", "group"]) if (m[k]) names.add(m[k]);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (list) => new RegExp(`(?<![\\p{L}\\p{N}_])(${[...list].map(esc).join("|")})(?![\\p{L}\\p{N}_])`, "iu");
const nameRe = wordRe(names), conceptRe = wordRe(CONCEPTS);

const findings = [];
const add = (file, n, rule, line, warn) => {
  const al = allowed(file, line);
  findings.push({ file, n, rule, line: line.trim().slice(0, 80), warn, reason: al ? al[2] : null });
};

/** Splits a source line into code (strings kept, comments dropped) and comment text. */
function splitLine(raw, st, lang) {
  let code = "", com = "", i = 0;
  while (i < raw.length) {
    if (st.block) {
      const e = raw.indexOf("*/", i);
      if (e < 0) { com += raw.slice(i); i = raw.length; } else { com += raw.slice(i, e); i = e + 2; st.block = false; }
      continue;
    }
    const c = raw[i], d = raw[i + 1];
    if (lang !== "css" && c === "/" && d === "/") { com += raw.slice(i + 2); break; }
    if (c === "/" && d === "*") { st.block = true; i += 2; continue; }
    if (lang !== "css" && (c === '"' || c === "'" || c === "`")) {
      let j = i + 1;
      while (j < raw.length && raw[j] !== c) j += raw[j] === "\\" ? 2 : 1;
      code += raw.slice(i, j + 1); i = j + 1; continue;
    }
    code += c; i++;
  }
  return { code, com };
}

function scan(f, lang) {
  const name = rel(f), st = { block: false };
  let cfgDepth = -1, depth = 0, pendingCfg = false;
  readFileSync(f, "utf8").split("\n").forEach((raw, i) => {
    const { code, com } = splitLine(raw, st, lang);
    if (lang === "rs") {
      if (/#\[cfg\(test\)\]/.test(code)) pendingCfg = true;
      const before = depth;
      for (const ch of code) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (pendingCfg && code.includes("{")) { cfgDepth = before; pendingCfg = false; return; }
      if (cfgDepth >= 0) { if (depth <= cfgDepth) cfgDepth = -1; return; }
      if (pendingCfg) return;
    }
    const hit = (re, rule) => {
      if (re.test(code)) add(name, i + 1, rule, raw, false);
      else if (re.test(com)) add(name, i + 1, rule + " (comment)", raw, true);
    };
    // kit is module-agnostic: no modules/, island/, core/state or core/bridge (CSS: module prefixes, rule 4).
    if (lang === "ts" && name.startsWith("src/kit/") && /\bfrom\s+["'][^"']*\/(modules|island)\/|\bfrom\s+["'][^"']*core\/(state|bridge)["']/.test(code))
      add(name, i + 1, "kit imports modules/island/state/bridge", raw, false);
    if (lang === "ts" && /\bfrom\s+["'][^"']*\/modules\/|\bimport\s*\(\s*["'][^"']*\/modules\//.test(code))
      add(name, i + 1, "import /modules/", raw, false);
    if (lang === "rs") {
      if (/\bmodules::/.test(code) && !/CATALOG|registry|handler/.test(code)) add(name, i + 1, "modules::", raw, false);
      for (const m of code.matchAll(/\.emit(?:_to)?\s*\(\s*(?:"[^"]*"\s*,\s*)?"([^"]+)"/g))
        if (!CORE_EVENTS.includes(m[1])) add(name, i + 1, `event "${m[1]}"`, raw, false);
    }
    hit(nameRe, "module name");
    hit(conceptRe, "concept");
  });
}

/** Class names (with a dash) in the selectors of a stylesheet: [{ cls, n }], n = line. */
function selectorClasses(f) {
  const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out = [];
  for (const m of text.matchAll(/([^{};]*)\{/g)) {
    if (/^\s*@(keyframes|font-face|property)/.test(m[1])) continue;
    const base = text.slice(0, m.index).split("\n").length;
    m[1].split("\n").forEach((ln, i) => { for (const c of ln.matchAll(/\.([a-zA-Z]\w*-[\w-]*)/g)) out.push({ cls: c[1], n: base + i }); });
  }
  return out;
}
const coreCss = files(join(root, "src/style"), [".css"]).concat(files(join(root, "src/kit"), [".css"])).concat(files(join(root, "src/settings"), [".css"]));
const coreClasses = new Set(coreCss.flatMap((f) => selectorClasses(f).map((x) => x.cls)));
const prefixOwners = new Map();
for (const m of moduleDirs)
  for (const f of files(join(root, "src/modules", m), [".css"]))
    for (const { cls } of selectorClasses(f)) if (!coreClasses.has(cls)) {
      const p = cls.split("-")[0];
      (prefixOwners.get(p) ?? prefixOwners.set(p, new Set()).get(p)).add(m);
    }
const modulePrefix = new Set([...prefixOwners].filter(([, o]) => o.size === 1).map(([p]) => p));
for (const f of coreCss) {
  const lines = readFileSync(f, "utf8").split("\n");
  for (const { cls, n } of selectorClasses(f)) if (modulePrefix.has(cls.split("-")[0])) add(rel(f), n, `css prefix "${cls.split("-")[0]}-"`, lines[n - 1], false);
}

for (const d of ["core", "island", "views", "mochi", "settings", "kit"]) for (const f of files(join(root, "src", d), [".ts"])) scan(f, "ts");
scan(join(root, "src/main.ts"), "ts");
for (const f of coreCss) scan(f, "css");
for (const f of files(join(root, "src-tauri/src/core"), [".rs"]).concat([join(root, "src-tauri/src/lib.rs")])) scan(f, "rs");

// ── Behavioural lints (see header) ───────────────────────────────────────────────
const ratchetFile = join(root, "scripts/neutrality-ratchet.json");
const ratchet = existsSync(ratchetFile) ? JSON.parse(readFileSync(ratchetFile, "utf8")) : {};
const codeLines = (f) => {
  const st = { block: false };
  return readFileSync(f, "utf8").split("\n").map((l) => splitLine(l, st, "ts").code);
};
const ALLOWED_CORE = /\/(core\/moduleApi|kit\/[\w/-]+)$/;
const stateImports = [], stateWrites = [], foreignImports = [];
for (const m of moduleDirs) for (const f of files(join(root, "src/modules", m), [".ts"])) {
  const lines = codeLines(f), code = lines.join("\n");
  for (const im of code.matchAll(/\bimport\s+(?!type\b)([^;]*?)\s+from\s+["']((?:\.\.\/)+(?:core|views|island|mochi|kit|style|settings)\/[^"']+)["']/g)) {
    const at = { m, file: rel(f), line: code.slice(0, im.index).split("\n").length };
    const clause = im[1].replace(/\btype\s+\w+/g, ""); // `{ type X }` is a type
    if (/core\/state$/.test(im[2])) { if (/\bState\b/.test(clause)) stateImports.push(at); }
    else if (!ALLOWED_CORE.test(im[2]) && /\w/.test(clause)) foreignImports.push({ ...at, what: im[2].replace(/^(\.\.\/)+/, "") });
  }
  lines.forEach((c, i) => { if (/\bState\.[\w.]+\s*(?:=(?!=)|\+=|-=)/.test(c)) stateWrites.push({ m, file: rel(f), line: i + 1 }); });
}

/** Field names of `interface|class name {…}`; for `nested` (IslandApi) the members of `group: { … }` come as `group.leaf`. */
function members(file, kind, name, nested) {
  const lines = codeLines(join(root, file));
  const start = lines.findIndex((l) => new RegExp(`\\b${kind}\\s+${name}\\b[^{]*\\{`).test(l));
  if (start < 0) { console.error(`lint: ${kind} ${name} not found in ${file}`); return []; }
  const body = []; // { t, d: depth at line start }
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    if (i > start) body.push({ t: lines[i], d: depth });
    for (const ch of lines[i]) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (depth <= 0) break;
  }
  const out = new Set();
  for (let i = 0; i < body.length; i++) {
    if (body[i].d !== 1) continue;
    const t = body[i].t;
    if (/^\s*(private|protected|static)\b/.test(t)) continue;
    const grp = nested && /^\s*(\w+)\??\s*:\s*\{/.exec(t);
    if (grp) {
      let text = t.slice(t.indexOf("{") + 1);
      for (let j = i + 1; j < body.length && body[j].d >= 2; j++) text += "\n" + body[j].t;
      for (const l of text.matchAll(/(?:^|[;{,\n])\s*(?:readonly\s+)?(\w+)\s*[<(]/g)) out.add(`${grp[1]}.${l[1]}`);
      continue;
    }
    const mm = /^\s*(?:readonly\s+)?(\w+)\??\s*(?:[:=]|<[^>]*>\s*\()/.exec(t) ?? (nested ? /^\s*(\w+)\s*\(/.exec(t) : null) ?? /^\s*get\s+(\w+)\s*\(/.exec(t);
    if (mm && !/^\s*(return|if|for)\b/.test(t)) out.add(mm[1]);
  }
  return [...out];
}
const srcTs = files(join(root, "src"), [".ts"]);
const coreTs = ["core", "island", "views", "mochi", "kit"].flatMap((d) => files(join(root, "src", d), [".ts"]));
const corpus = (list) => list.map((f) => ({ f, code: codeLines(f).join("\n") }));
const coreCode = corpus(coreTs), apiCode = corpus(srcTs.filter((f) => !/core\/(moduleApi|registry)\.ts$/.test(rel(f)))), moduleCode = corpus(srcTs.filter((f) => rel(f).startsWith("src/modules/")));
const notWrite = String.raw`(?!\s*(?:=(?!=)|[+\-*]=|\+\+|--))`;
const readIn = (list, path) => {
  const dotted = path.split(".").map((p) => `\\.\\s*${p}\\b`).join("\\s*");
  const re = new RegExp(`${dotted}${notWrite}`);
  const bare = path.includes(".") ? null : new RegExp(`\\{[^}]*\\b${path}\\b[^}]*\\}\\s*=\\s*\\w`); // const { name } = State
  return list.some((x) => re.test(x.code) || (bare && bare.test(x.code)));
};
const deadFields = [];
for (const [owner, file, kind, name, nested, scope] of [
  ["Settings", "src/core/state.ts", "interface", "Settings", false, coreCode],
  ["AppState", "src/core/state.ts", "class", "AppState", false, coreCode],
  ["ViewLayout", "src/core/layout.ts", "interface", "ViewLayout", false, coreCode],
  ["IslandApi", "src/core/moduleApi.ts", "interface", "IslandApi", true, apiCode],
]) for (const field of members(file, kind, name, nested)) {
  if (readIn(scope, field)) continue;
  const leaf = field.split(".").pop();
  const mods = moduleCode.reduce((n, x) => n + (x.code.match(new RegExp(`\\b${leaf}\\b`, "g")) ?? []).length, 0);
  deadFields.push({ owner, field, mods });
}

const lintCounts = { stateImports: stateImports.length, stateWrites: stateWrites.length, foreignCoreImports: foreignImports.length, deadFields: deadFields.length };
if (process.argv.includes("--write-ratchet")) {
  const next = Object.fromEntries(Object.entries(lintCounts).map(([k, v]) => [k, Math.min(v, ratchet[k] ?? v)]));
  // `reasons` (why a count stays above zero) is hand-written: keep it.
  writeFileSync(ratchetFile, JSON.stringify({ ...next, ...(ratchet.reasons && { reasons: ratchet.reasons }) }, null, 2) + "\n");
  Object.assign(ratchet, next);
}
console.log("\nLINTS (fail on a count above the ratchet; --warn-lints only prints)");
const perModule = (list, label, extra = () => "") => {
  const by = new Map();
  for (const x of list) (by.get(x.m) ?? by.set(x.m, []).get(x.m)).push(`${x.file.replace(/^src\/modules\/[^/]+\//, "")}:${x.line}${extra(x)}`);
  for (const [m, l] of [...by].sort()) console.log(`  ${label} ${m.padEnd(14)} ${l.length}  ${l.join(" ")}`);
};
perModule(stateImports, "State import  ");
perModule(stateWrites, "State write   ");
perModule(foreignImports, "core import   ", (x) => ` (${x.what})`);
for (const d of deadFields) console.log(`  dead field    ${(d.owner + "." + d.field).padEnd(30)} ${d.mods ? `mentioned ${d.mods}x in modules` : "unused"}`);
let lintBad = 0;
for (const [k, v] of Object.entries(lintCounts)) {
  const cap = ratchet[k];
  const state = cap == null ? "no ratchet" : v > cap ? "ABOVE ratchet" : v < cap ? "below ratchet (lower it with --write-ratchet)" : "at ratchet";
  if (cap == null || v > cap) lintBad++;
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(3)} / ${cap ?? "-"}  ${state}`);
  if (ratchet.reasons?.[k]) console.log(`      why it stays: ${ratchet.reasons[k]}`);
}

const live = findings.filter((x) => !x.reason);
const bad = fail ? live : live.filter((x) => !x.warn);
if (process.argv.includes("--verbose"))
  for (const x of live) console.log(`${x.file}:${x.n}`.padEnd(48) + (x.warn ? "warn " : "FIND ") + x.rule.padEnd(22) + x.line);
const per = new Map();
for (const x of live) {
  const e = per.get(x.file) ?? { f: 0, w: 0 };
  if (x.warn) e.w++; else e.f++;
  per.set(x.file, e);
}
console.log("file".padEnd(40) + "findings  warnings");
for (const [f, e] of [...per].sort()) console.log(f.padEnd(40) + String(e.f).padStart(8) + String(e.w).padStart(10));
console.log(`\nTOTAL findings ${bad.length}, warnings ${live.length - bad.length}, allowlisted ${findings.length - live.length}`);
process.exit((fail && bad.length) || (failLints && lintBad) ? 1 : 0);
