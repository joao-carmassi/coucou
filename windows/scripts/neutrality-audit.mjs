// Static neutrality audit: "the core (island + Mochi) knows no module".
// Scope: src/{core,island,views,mochi,settings,style}/**, src/main.ts, src-tauri/src/core/**, src-tauri/src/lib.rs.
// FAIL by default: exit 1 on any non-allowlisted finding (comment-only hits are warnings and never fail).
// `--warn` keeps the old behaviour (print, exit 0).
// Run: npm run neutrality-audit [-- --warn] [-- --verbose]
//
// Rules:
//   1. TS import path containing `/modules/` (core/registry.ts and settings/main.ts may import modules/settings + catalog).
//   2. Module id / label / group (derived from src/modules/* folders and their manifest.json) as a whole word in code
//      (comment-only hits are counted as warnings: rule "... (comment)").
//   3. Concept denylist (approval, session, overview, ...) in code (comment-only: warning).
//   4. CSS: a selector of a core sheet (src/style, src/settings) must not use a module's class prefix (gh-, sess-, int-, ...).
//      Prefixes come from the selectors of src/modules/*/*.css that no core sheet defines and that only ONE module uses
//      (a prefix two modules share is the shared kit's: pane-, diff-). Allowlist a hit with a reason.
//   5. Rust: `modules::` outside CATALOG/registry/handler lines; events emitted by core must be generic;
//      `#[cfg(test)]` blocks are skipped.
//
// ALLOWLIST: [file suffix, substring of the offending line, reason]. Keep each entry justified.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const fail = !process.argv.includes("--warn");

const ALLOWLIST = [
  ["src/core/registry.ts", "modules/index", "the only core file that loads the module list"],
  ["src/core/registry.ts", "modules/catalog", "registry reads the catalog"],
  ["src/settings/main.ts", "modules/settings", "settings window loads the sections only (no island code or CSS)"],
  ["src/settings/main.ts", "modules/catalog", "settings window lists the modules"],
  // Legacy alias maps: old persisted/emitted names still accepted for one version window; delete with the window.
  ["src/core/badge.ts", "LegacyBadgeName", "legacy alias (one-version window)"],
  ["src/core/badge.ts", "BADGE_ALIAS", "legacy alias (one-version window)"],
  ["src/core/layout.ts", "MOOD_ALIAS", "legacy alias (one-version window)"],
  ["src/core/layout.ts", "LegacyMoodName", "legacy alias (one-version window)"],
  ["src/core/sound.ts", "const FILE", "sound file names keep the old wav names (alias window)"],
  ["src/core/sound.ts", "SOUND_ALIAS", "legacy alias (one-version window)"],
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
const coreCss = files(join(root, "src/style"), [".css"]).concat(files(join(root, "src/settings"), [".css"]));
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

for (const d of ["core", "island", "views", "mochi", "settings"]) for (const f of files(join(root, "src", d), [".ts"])) scan(f, "ts");
scan(join(root, "src/main.ts"), "ts");
for (const f of files(join(root, "src/style"), [".css"]).concat(files(join(root, "src/settings"), [".css"]))) scan(f, "css");
for (const f of files(join(root, "src-tauri/src/core"), [".rs"]).concat([join(root, "src-tauri/src/lib.rs")])) scan(f, "rs");

const live = findings.filter((x) => !x.reason);
const bad = live.filter((x) => !x.warn);
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
process.exit(fail && bad.length ? 1 : 0);
