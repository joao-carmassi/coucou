// Scaffolds a module: src/modules/<id>/ (+ src-tauri/src/modules/<id>/mod.rs with --rust) and tests/harness/<id>.test.ts.
// Usage: npm run new-module -- <id> [--rust] [--view] [--label "Nome"]
// COUCOU_ROOT replaces the windows/ root (the tests point it at a temp copy; the real tree is not touched).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.COUCOU_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_DIR = join(root, "src/modules");
const RS_DIR = join(root, "src-tauri/src/modules");
const HARNESS = join(root, "tests/harness");

// Rust keywords and names the generated `pub mod <id>;` would shadow.
const RESERVED = ["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "abstract", "become", "box", "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "core", "std", "alloc", "tauri"];

function die(msg) {
  console.error(`new-module: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags = { rust: false, view: false, label: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--rust") flags.rust = true;
  else if (a === "--view") flags.view = true;
  else if (a === "--label") {
    if (argv[i + 1] === undefined) die("--label needs a value");
    flags.label = argv[++i];
  } else if (a.startsWith("--")) die(`unknown option ${a}`);
  else positional.push(a);
}
if (positional.length !== 1) die('usage: npm run new-module -- <id> [--rust] [--view] [--label "Nome"]');

const [id] = positional;
const label = flags.label ?? id;
if (!/^[a-z][a-z0-9]{2,15}$/.test(id)) die(`id "${id}" must match ^[a-z][a-z0-9]{2,15}$`);
if (RESERVED.includes(id)) die(`id "${id}" is a reserved word (Rust keyword or crate name)`);
if (/[\r\n]/.test(label) || !label.trim()) die("--label must be one line, not empty");

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const manifests = () => (isDir(TS_DIR) ? readdirSync(TS_DIR) : [])
  .map((n) => join(TS_DIR, n, "manifest.json"))
  .filter((p) => existsSync(p))
  .flatMap((p) => [JSON.parse(readFileSync(p, "utf8"))].flat());

// Rust prefixes declared by every folder (the same parse build.rs and the neutrality audit use).
const rustPrefixes = () => (isDir(RS_DIR) ? readdirSync(RS_DIR) : [])
  .map((n) => join(RS_DIR, n, "mod.rs"))
  .filter((p) => existsSync(p))
  .flatMap((p) => {
    const text = readFileSync(p, "utf8");
    const decl = text.split("pub const PREFIXES")[1] ?? "";
    const list = decl.slice(decl.indexOf("="), decl.indexOf(";"));
    return [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  });

const existing = manifests();
if (isDir(join(TS_DIR, id)) || isDir(join(RS_DIR, id)) || existing.some((m) => m.id === id))
  die(`module "${id}" already exists`);
const mine = `${id}_`;
const clash = rustPrefixes().find((p) => mine.startsWith(p) || p.startsWith(mine));
if (clash) die(`Rust prefix "${mine}" collides with "${clash}" of another module`);

const order = Math.max(0, ...existing.map((m) => m.order)) + 1;
const Pascal = id[0].toUpperCase() + id.slice(1);
const dir = join(TS_DIR, id);
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const created = [];

created.push(write(join(dir, "manifest.json"), `${JSON.stringify({ id, label, default: false, order, settingsDefaults: {} }, null, 2)}\n`));

const viewImport = flags.view ? `import { buildView } from "./view";\n` : "";
const viewDef = flags.view ? `  views: [{ name: "${id}", layout: { height: 120, botX: 54, botY: null, botDiameter: 46 }, build: () => buildView() }],
  tabs: [{ view: "${id}", title: ${JSON.stringify(label)}, icon: () => svg(ICONS.dial, 13), order: 100 }],
` : "";
const kitImport = flags.view ? `import { svg } from "../../kit/dom";\nimport { ICONS } from "../../kit/icons";\n` : "";
created.push(write(join(dir, "index.ts"), `// ${label}: scaffolded module (scripts/new-module.mjs). start() is a no-op until it does something; see docs/MODULES-CONTRACT.md.
import "./${id}.css";
${kitImport}import type { Disposer, IslandApi, ModuleDef } from "../../core/moduleApi";
${viewImport}
function start(_api: IslandApi): Disposer {
  return () => {};
}

export const ${id}Module: ModuleDef = {
  id: "${id}",
${viewDef}  start,
};
`));

created.push(write(join(dir, `${id}.css`), flags.view
  ? `/* ${label}: this module's classes, all prefixed "${id}-". Reuse kit classes; never redefine them. */\n.${id}-view { font: 400 12px var(--font); color: var(--dim); }\n`
  : `/* ${label}: this module's classes, all prefixed "${id}-". Reuse kit classes; never redefine them. */\n`));

if (flags.view) {
  created.push(write(join(dir, "view.ts"), `// ${label} view: a stub. Build it with the kit atoms (docs/MODULES-CONTRACT.md).
import type { ViewHost } from "../../core/moduleApi";

export function buildView(): ViewHost {
  const el = document.createElement("div");
  el.className = "${id}-view";
  el.textContent = ${JSON.stringify(label)};
  return { el, sync() {} };
}
`));
}

created.push(write(join(HARNESS, `${id}.test.ts`), `// ${label}: the module starts when on and stops when off, through the registry (as the other module tests do).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { buildCatalog } from "../../src/modules/resolve";
import { ${id}Module } from "../../src/modules/${id}";

beforeAll(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [${id}Module], buildCatalog([{ id: "${id}", label: ${JSON.stringify(label)}, default: false, order: ${order} }], true));
});

describe("${id} module", () => {
  it("starts when on and stops when off", () => {
    const start = vi.spyOn(${id}Module, "start");
    Registry.apply({ "${id}": true });
    expect(start).toHaveBeenCalledTimes(1);
    expect(Registry.isOn("${id}")).toBe(true);
    Registry.apply({ "${id}": false });
    expect(Registry.isOn("${id}")).toBe(false);
  });
});
`));

if (flags.rust) {
  const Struct = `${Pascal}Module`;
  created.push(write(join(RS_DIR, id, "mod.rs"), `// ${label}: Rust side, scaffolded (scripts/new-module.mjs). build.rs finds this folder and routes "${mine}" commands here.

use crate::core::host::{Module, ModuleCtx};
use crate::core::settings::Settings;

pub struct ${Struct};

impl Module for ${Struct} {
    fn id(&self) -> &'static str {
        "${id}"
    }

    fn start(&self, _ctx: &ModuleCtx, _s: &Settings) {}
}

pub const PREFIXES: &[&str] = &["${mine}"];

pub fn modules() -> Vec<Box<dyn Module>> {
    vec![Box::new(${Struct})]
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![${id}_ping])
}

#[tauri::command]
pub fn ${id}_ping() -> String {
    "pong".into()
}
`));
}

console.log(`created module "${id}" (order ${order}, default false):`);
for (const p of created) console.log(`  ${p.slice(root.length + 1).replaceAll("\\", "/")}`);
console.log(`next steps:
  1. write start() in src/modules/${id}/index.ts (docs/MODULES-CONTRACT.md, "How to add a module")
  2. cd windows && npm run check   (tsc, unit tests, harness, idle-audit, neutrality-audit)${flags.rust ? `
  3. cd windows/src-tauri && cargo check && cargo test   (Rust side: ${id}_ping)` : ""}
  ${flags.rust ? "4" : "3"}. turn it on in Settings to try it; set "default": true in its manifest only when it should ship on`);
