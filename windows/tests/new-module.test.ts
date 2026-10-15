// The scaffolder runs in a temp copy of the module trees (COUCOU_ROOT), so the real src/ is never written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const windowsDir = fileURLToPath(new URL("../", import.meta.url));
const script = join(windowsDir, "scripts/new-module.mjs");
const real = (p: string) => join(windowsDir, p);

const root = mkdtempSync(join(tmpdir(), "coucou-new-module-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "tests/harness"), { recursive: true });
mkdirSync(join(root, "src-tauri/src"), { recursive: true });
cpSync(real("src/modules"), join(root, "src/modules"), { recursive: true });
cpSync(real("src-tauri/src/modules"), join(root, "src-tauri/src/modules"), { recursive: true });

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, COUCOU_ROOT: root } });
const tsDir = join(root, "src/modules");
const rsDir = join(root, "src-tauri/src/modules");
const maxOrder = () => Math.max(0, ...readdirSync(tsDir).flatMap((n) => {
  const p = join(tsDir, n, "manifest.json");
  return existsSync(p) ? [JSON.parse(readFileSync(p, "utf8"))].flat().map((m: { order: number }) => m.order) : [];
}));

test("new-module: TS-only scaffold writes the folder, harness test and manifest fields", () => {
  const before = maxOrder();
  const r = run("zeta");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = join(tsDir, "zeta");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, { id: "zeta", label: "zeta", default: false, order: before + 1, settingsDefaults: {} });
  const index = readFileSync(join(dir, "index.ts"), "utf8");
  assert.match(index, /import "\.\/zeta\.css";/);
  assert.match(index, /export const zetaModule: ModuleDef = \{/);
  assert.match(index, /return \(\) => \{\};/);
  assert.doesNotMatch(index, /views:/, "no view without --view");
  assert.ok(existsSync(join(dir, "zeta.css")));
  assert.ok(!existsSync(join(dir, "view.ts")));
  assert.ok(!existsSync(join(rsDir, "zeta")), "no Rust folder without --rust");
  const harness = readFileSync(join(root, "tests/harness/zeta.test.ts"), "utf8");
  assert.match(harness, /Registry\.apply\(\{ "zeta": true \}\)/);
  assert.match(harness, /from "\.\.\/\.\.\/src\/modules\/zeta"/);
});

test("new-module: order is max + 1 again for the next module", () => {
  const before = maxOrder();
  assert.equal(run("eta").status, 0);
  assert.equal(JSON.parse(readFileSync(join(tsDir, "eta/manifest.json"), "utf8")).order, before + 1);
});

test("new-module: --rust --view --label writes view, Rust folder with the prefix and ping command", () => {
  const r = run("omega", "--rust", "--view", "--label", "Nome");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const manifest = JSON.parse(readFileSync(join(tsDir, "omega/manifest.json"), "utf8"));
  assert.equal(manifest.label, "Nome");
  assert.match(readFileSync(join(tsDir, "omega/view.ts"), "utf8"), /className = "omega-view"/);
  assert.match(readFileSync(join(tsDir, "omega/omega.css"), "utf8"), /\.omega-view \{/);
  const rs = readFileSync(join(rsDir, "omega/mod.rs"), "utf8");
  assert.match(rs, /pub const PREFIXES: &\[&str\] = &\["omega_"\];/);
  assert.match(rs, /pub fn omega_ping\(\)/);
  assert.match(rs, /generate_handler!\[omega_ping\]/);
});

test("new-module: rejects bad ids, existing modules, reserved words and unknown options, writing nothing", () => {
  const files = () => readdirSync(tsDir).sort().join(",");
  const snapshot = files();
  for (const args of [[], ["ab"], ["Abc"], ["1abc"], ["a".repeat(17)], ["zeta"], ["clock"], ["media"], ["match", "--rust"], ["fine", "--bogus"], ["x_y"]]) {
    const r = run(...args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(files(), snapshot);
  assert.ok(!existsSync(join(rsDir, "fine")));
});
