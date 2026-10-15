// The scaffolder runs in a temp copy of the module trees (COUCOU_ROOT), so the real src/ is never written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const windowsDir = fileURLToPath(new URL("../", import.meta.url));
const script = join(windowsDir, "scripts/new-module.mjs");
const real = (p: string) => join(windowsDir, p);

const root = mkdtempSync(join(tmpdir(), "coucou-new-module-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "tests/harness"), { recursive: true });
cpSync(real("src"), join(root, "src"), { recursive: true });
cpSync(real("src-tauri/src"), join(root, "src-tauri/src"), { recursive: true });

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, COUCOU_ROOT: root } });
const tsDir = join(root, "src/modules");
const rsDir = join(root, "src-tauri/src/modules");
const manifestsOf = () => readdirSync(tsDir).flatMap((n) => {
  const p = join(tsDir, n, "manifest.json");
  return existsSync(p) ? [JSON.parse(readFileSync(p, "utf8"))].flat() : [];
});
// Next order the scaffolder must pick: devOnly modules do not count.
const nextOrder = () => Math.max(0, ...manifestsOf().filter((m) => !m.devOnly).map((m) => m.order)) + 1;

test("new-module: TS-only scaffold writes the folder, harness test and manifest fields", () => {
  const want = nextOrder();
  const r = run("zeta");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = join(tsDir, "zeta");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, { id: "zeta", label: "zeta", default: false, order: want, settingsDefaults: {} });
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

test("new-module: order is the next free one after the non-devOnly modules", () => {
  const want = nextOrder();
  assert.equal(run("eta").status, 0);
  assert.equal(JSON.parse(readFileSync(join(tsDir, "eta/manifest.json"), "utf8")).order, want);
});

test("new-module: a devOnly module does not push the order past it", () => {
  mkdirSync(join(tsDir, "hiddenx"), { recursive: true });
  writeFileSync(join(tsDir, "hiddenx/manifest.json"), JSON.stringify({ id: "hiddenx", label: "Oculto", default: false, order: 500, devOnly: true }));
  const want = nextOrder();
  assert.ok(want < 500, `next order ${want} must not count the devOnly module at 500`);
  assert.equal(run("theta").status, 0);
  assert.equal(JSON.parse(readFileSync(join(tsDir, "theta/manifest.json"), "utf8")).order, want);
});

test("new-module: --order sets the order; a non-number is refused", () => {
  const r = run("ordered", "--order", "42");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(readFileSync(join(tsDir, "ordered/manifest.json"), "utf8")).order, 42);
  assert.equal(run("badord", "--order", "x").status, 1);
  assert.ok(!existsSync(join(tsDir, "badord")));
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

test("new-module: refuses an id that prefixes a core command", () => {
  writeFileSync(join(root, "src-tauri/src/probe_core.rs"), "#[tauri::command]\npub fn lambda_probe() {}\n");
  const r = run("lambda", "--rust");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /core command "lambda_probe"/);
  assert.ok(!existsSync(join(tsDir, "lambda")));
  assert.equal(run("lambdb").status, 0, "a different prefix is fine");
});

test("new-module: refuses to overwrite an existing harness test", () => {
  const harness = join(root, "tests/harness/kappa.test.ts");
  writeFileSync(harness, "// hand written\n");
  const r = run("kappa");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readFileSync(harness, "utf8"), "// hand written\n");
  assert.ok(!existsSync(join(tsDir, "kappa")), "nothing written when refused");
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
