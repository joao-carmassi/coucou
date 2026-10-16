// Static neutrality audit: "the core (island + Mochi) knows no module".
// Scope: src/{core,island,views,mochi,settings,style,kit}/**, src/main.ts, src-tauri/src/core/**, src-tauri/src/lib.rs.
// FAIL by default: exit 1 on any non-allowlisted finding, comment-only hits included.
// `--warn` prints everything and exits 0 (comment hits shown as warnings).
// Run: npm run neutrality-audit [-- --warn] [-- --verbose]
//
// LINTS (behavioural; FAIL by default when a count is above scripts/neutrality-ratchet.json; `--warn-lints` only prints):
//   A. boundary: src/modules/** must not import `State` (value import from core/state), write `State.<field> =`, or
//      value-import core other than core/moduleApi, kit/* (`import type` is always fine). From core/state only `State` may
//      be value-imported (and counts as a stateImport); anything else from there is a foreign core import.
//   A2. crossModuleImports: a module value-imports `../<other>/x` where x is not `api` (`import type` is fine).
//   K. kit rule (a finding, not a ratchet): src/kit/** may value-import only kit/* and @tauri-apps/*; from core/ and mochi/
//      only `import type`.
//   K2. kit CSS: kit stylesheets use only kit class prefixes (pane-, tile-, diff-, code-, file-, hl-, plus the kit-owned home layout names overview/left/solo), and no module stylesheet
//      defines a NEW pane-/tile-/diff- class (it may refine one the kit defines, e.g. `.tile-card.detail`).
//   K3. kit class literals (ZERO allowlist): in src/modules/**/*.ts (comments stripped) no string/template token may be a class the
//      kit CSS defines (pane-*, tile-*, diff-*, code-*, file-*, hl*, home*, solo, left-body) nor, in a class context (`class:` /
//      `className:` / `cls:` values, classList.add|remove|toggle|contains args, querySelector(All) strings), `card` / `wash` / `view`.
//      Build those elements with the kit atoms instead.
//   B. dead fields: every field of Settings, AppState, ViewLayout and IslandApi must be READ in src/{core,island,views,mochi,kit}
//      (Settings: also src/settings/** and src/main.ts; IslandApi: used by any src file but moduleApi.ts/registry.ts, since modules are its readers).
// scripts/neutrality-ratchet.json holds the counts; they may only go down (zero is enforced regardless).
//
// Rules:
//   1. TS import path containing `/modules/` (core/registry.ts and settings/main.ts may import modules/settings + catalog).
//   2. Module id / label / group / machineKeys / non-generic preset ids (derived from src/modules/* folders and their manifest.json) as a whole word in code
//      (comment hits carry the rule suffix "(comment)" and fail too).
//   3. Concept denylist (approval, session, overview, ...) in code or comments.
//   4. CSS: a selector of a core sheet (src/style, src/settings) must not use a module's class prefix (gh-, sess-, int-, ...).
//      Prefixes come from the selectors of src/modules/*/*.css that no core sheet defines and that only ONE module uses
//      (a prefix two modules share is the shared kit's: pane-, diff-). Allowlist a hit with a reason.
//   5. Rust: `modules::` outside CATALOG/registry/handlers lines (lib.rs may call `modules::handlers()` / `modules::registry()`);
//      events emitted by core must be generic; `#[cfg(test)]` blocks are skipped.
//   R. Rust command prefixes: every string passed to command/commandOrThrow in src/modules/** must start with a prefix some
//      src-tauri/src/modules/<f>/mod.rs declares (`pub const PREFIXES`, parsed as build.rs does), unless the TS module has no
//      Rust folder (TS-only).
//
// ALLOWLIST: [file suffix, substring of the offending line, reason]. Keep each entry justified.
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const fail = !process.argv.includes("--warn");
const failLints = !process.argv.includes("--warn-lints") && !process.argv.includes("--warn");

const ALLOWLIST = []; // must stay empty (tests/audits.test.ts); a stale entry would fail below
const CORE_EVENTS = ["cursor", "tray", "screen-changed", "settings-changed", "settings-shown", "modules-changed", "file-drag", "hotkey-error", "inbox-added", "presence", "palette"];
const GENERIC_PRESETS = ["essencial", "dev", "tudo"]; // the Hub labels these itself; any other preset id is a module's name
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
const usedEntries = new Set();
const allowed = (file, line) => { const e = ALLOWLIST.find(([f, s]) => file.endsWith(f) && line.includes(s)); if (e) usedEntries.add(e); return e; };

// Names: folder ids + ids/labels/groups from the manifests.
const moduleDirs = readdirSync(join(root, "src/modules")).filter((n) => statSync(join(root, "src/modules", n)).isDirectory());
const names = new Set(readdirSync(join(root, "src/modules")).filter((n) => statSync(join(root, "src/modules", n)).isDirectory()));
for (const n of [...names]) {
  const f = join(root, "src/modules", n, "manifest.json");
  if (!existsSync(f)) continue;
  for (const m of [JSON.parse(readFileSync(f, "utf8"))].flat()) {
    for (const k of ["id", "label", "group"]) if (m[k]) names.add(m[k]);
    // Keys a module declares as per-machine, and preset ids beyond the generic ones, are as much its names as its id.
    for (const k of m.machineKeys ?? []) names.add(k);
    for (const p of m.presets ?? []) if (!GENERIC_PRESETS.includes(p)) names.add(p);
  }
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
      if (/\bmodules::/.test(code) && !/CATALOG|registry|handlers/.test(code)) add(name, i + 1, "modules::", raw, false);
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
// Kit rule: value imports only from kit/* and @tauri-apps/*.
for (const f of files(join(root, "src/kit"), [".ts"])) {
  const code = codeLines(f).join("\n");
  for (const im of code.matchAll(/\b(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (!/\w/.test(im[1].replace(/\btype\s+\w+/g, "")) || /^(\.\/|@tauri-apps\/|\.\.\/kit\/)/.test(im[2])) continue;
    add(rel(f), code.slice(0, im.index).split("\n").length, "kit value import outside kit/@tauri-apps", im[0].split("\n")[0], false);
  }
}

// K2: kit CSS prefixes, and modules do not grow the kit's namespaces. (Separate from the rules above.)
{
  const KIT_PREFIXES = ["pane", "tile", "diff", "code", "file", "hl", "home", "left", "solo"];
  const NAMESPACES = ["pane", "tile", "diff"];
  const kitCss = files(join(root, "src/kit"), [".css"]);
  const kitDefined = new Set();
  for (const f of kitCss) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (const { cls, n } of selectorClasses(f)) {
      kitDefined.add(cls);
      if (!KIT_PREFIXES.includes(cls.split("-")[0])) add(rel(f), n, "K2 kit css prefix", lines[n - 1], false);
    }
  }
  for (const m of moduleDirs) for (const f of files(join(root, "src/modules", m), [".css"])) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (const { cls, n } of selectorClasses(f))
      if (NAMESPACES.includes(cls.split("-")[0]) && !kitDefined.has(cls)) add(rel(f), n, "K2 module defines kit-namespace class", lines[n - 1], false);
  }
}

// K3: modules never spell a kit class. ZERO allowlist (findings are never allowlisted).
{
  const kitClasses = new Set();
  for (const f of files(join(root, "src/kit"), [".css"])) {
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/([^{};]*)\{/g)) {
      if (/^\s*@(keyframes|font-face|property)/.test(m[1])) continue;
      for (const c of m[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) kitClasses.add(c[1]);
    }
  }
  const isKit = (c) => /^(pane-|tile-|diff-|code-|file-|hl|home)/.test(c) || c === "solo" || c === "left-body" || c === "pane-file";
  // bare `home` / `card` / `wash` / `view` are also plain words (view names, state values): checked in class contexts only
  const BARE = new Set(["card", "wash", "view", "home", "left", "right"]);
  const kitSet = new Set([...kitClasses].filter((c) => isKit(c) && !BARE.has(c)));
  const lit = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  const toks = (str) => str.split(/[\s.,>+~]+/).filter(Boolean);
  const ctx = [/\b(?:class|className|cls)\s*:\s*/g, /\bclassList\s*\.\s*(?:add|remove|toggle|contains)\s*\(/g, /\bquerySelector(?:All)?\s*\(/g];
  for (const m of moduleDirs) for (const f of files(join(root, "src/modules", m), [".ts"])) {
    codeLines(f).forEach((c, i) => {
      for (const l of c.matchAll(lit)) for (const t of toks(l[2])) if (kitSet.has(t)) add(rel(f), i + 1, `K3 kit class "${t}" in a module`, c, false);
      for (const re of ctx) for (const cm of c.matchAll(re)) {
        const tail = c.slice(cm.index + cm[0].length).split(/[)}]/)[0];
        for (const l of tail.matchAll(lit)) for (const t of toks(l[2])) if (BARE.has(t)) add(rel(f), i + 1, `K3 kit class "${t}" in a module`, c, false);
      }
    });
  }
}

const ALLOWED_CORE = /\/(core\/moduleApi|kit\/[\w/-]+)$/;
const stateImports = [], stateWrites = [], foreignImports = [], crossImports = [];
for (const m of moduleDirs) for (const f of files(join(root, "src/modules", m), [".ts"])) {
  const lines = codeLines(f), code = lines.join("\n");
  for (const im of code.matchAll(/\bimport\s+(?!type\b)([^;]*?)\s+from\s+["']((?:\.\.\/)+(?:core|views|island|mochi|kit|style|settings)\/[^"']+)["']/g)) {
    const at = { m, file: rel(f), line: code.slice(0, im.index).split("\n").length };
    const clause = im[1].replace(/\btype\s+\w+/g, ""); // `{ type X }` is a type
    if (/core\/state$/.test(im[2])) {
      const names = clause.replace(/[{}]/g, "").split(",").map((x) => x.trim()).filter(Boolean);
      if (names.includes("State")) stateImports.push(at);
      if (names.some((x) => x !== "State")) foreignImports.push({ ...at, what: "core/state" });
    }
    else if (!ALLOWED_CORE.test(im[2]) && /\w/.test(clause)) foreignImports.push({ ...at, what: im[2].replace(/^(\.\.\/)+/, "") });
  }
  for (const im of code.matchAll(/\bimport\s+(?!type\b)([^;]*?)\s+from\s+["']((?:\.\.?\/)+[^"']+)["']/g)) {
    if (!/\w/.test(im[1].replace(/\btype\s+\w+/g, ""))) continue;
    const target = relative(join(root, "src/modules"), resolve(dirname(f), im[2])).split(sep);
    if (target[0] === ".." || target[0] === m || target.length < 2 || target.slice(1).join("/").replace(/\.ts$/, "") === "api") continue;
    crossImports.push({ m, file: rel(f), line: code.slice(0, im.index).split("\n").length, what: target.join("/") });
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
const settingsCode = corpus([...files(join(root, "src/settings"), [".ts"]), join(root, "src/main.ts")]);
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
  ["Settings", "src/core/state.ts", "interface", "Settings", false, [...coreCode, ...settingsCode]],
  ["AppState", "src/core/state.ts", "class", "AppState", false, coreCode],
  ["ViewLayout", "src/core/layout.ts", "interface", "ViewLayout", false, coreCode],
  ["IslandApi", "src/core/moduleApi.ts", "interface", "IslandApi", true, apiCode],
]) for (const field of members(file, kind, name, nested)) {
  if (readIn(scope, field)) continue;
  const leaf = field.split(".").pop();
  const mods = moduleCode.reduce((n, x) => n + (x.code.match(new RegExp(`\\b${leaf}\\b`, "g")) ?? []).length, 0);
  deadFields.push({ owner, field, mods });
}

const lintCounts = { stateImports: stateImports.length, stateWrites: stateWrites.length, foreignCoreImports: foreignImports.length, crossModuleImports: crossImports.length, deadFields: deadFields.length };
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
perModule(crossImports, "cross import  ", (x) => ` (${x.what})`);
for (const d of deadFields) console.log(`  dead field    ${(d.owner + "." + d.field).padEnd(30)} ${d.mods ? `mentioned ${d.mods}x in modules` : "unused"}`);
let lintBad = 0;
for (const [k, v] of Object.entries(lintCounts)) {
  const cap = 0; // zero is the rule: the ratchet file is informational, any nonzero count fails
  const state = cap == null ? "no ratchet" : v > cap ? "ABOVE ratchet" : v < cap ? "below ratchet (lower it with --write-ratchet)" : "at ratchet";
  if (cap == null || v > cap) lintBad++;
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(3)} / ${cap ?? "-"}  ${state}`);
  if (ratchet.reasons?.[k]) console.log(`      why it stays: ${ratchet.reasons[k]}`);
}

// Rule R: command names called from module bridges vs the prefixes the Rust folders declare.
const rustDir = join(root, "src-tauri/src/modules");
const rustPrefixes = new Map(); // folder -> prefixes
for (const f of readdirSync(rustDir)) {
  const mod = join(rustDir, f, "mod.rs");
  if (!existsSync(mod)) continue;
  const decl = readFileSync(mod, "utf8").split("pub const PREFIXES")[1] ?? "";
  rustPrefixes.set(f, decl.slice(decl.indexOf("="), decl.indexOf(";")).split('"').filter((_, i) => i % 2 === 1));
}
const allPrefixes = [...rustPrefixes.values()].flat();
for (const m of moduleDirs) for (const f of files(join(root, "src/modules", m), [".ts"])) {
  if (!rustPrefixes.has(m)) continue; // TS-only module: no Rust commands of its own
  codeLines(f).forEach((c, i) => {
    for (const x of c.matchAll(/\bcommand(?:OrThrow)?\s*(?:<[^>(]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g))
      if (!allPrefixes.some((p) => x[1].startsWith(p))) add(rel(f), i + 1, `command "${x[1]}" matches no Rust PREFIXES`, c, false);
  });
}

ALLOWLIST.forEach((e) => { if (!usedEntries.has(e)) findings.push({ file: e[0], n: 0, rule: "unused ALLOWLIST entry", line: e[1], warn: false, reason: null }); });
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
