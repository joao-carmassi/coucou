// CSS equality check for kit refactors: the SET of (at-rule context, selector, declarations) of the built CSS must not change,
// except the declarations listed in VARIABLIZED (a fixed value that became `var(--x, same value)`). Rule ORDER is reported, not failed
//   node scripts/css-rules.mjs snapshot <dir>   build and save the built CSS to <dir>
//   node scripts/css-rules.mjs compare  <dir>   build and compare with the snapshot in <dir>; exit 1 on a difference
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss"; // vite's own dependency

const root = join(fileURLToPath(import.meta.url), "..", "..");
const [mode, dir] = process.argv.slice(2);

/** Declarations allowed to differ: [selector, prop, before, after]. The `after` must be var(--x, <before>). */
const VARIABLIZED = [
  [".tile-card", "padding", "10px 12px 0 108px", "10px 12px 0 var(--tile-inset, 108px)"],
  [".pane-side", "flex", "0 0 113px", "0 0 var(--pane-side-w, 113px)"],
  [".pane-side", "padding", "119px 8px 12px 13px", "var(--pane-side-top, 119px) 8px 12px 13px"],
];

function builtCss() {
  const out = mkdtempSync(join(tmpdir(), "css-rules-"));
  execSync(`npx vite build --outDir "${out}" --emptyOutDir`, { cwd: root, stdio: "pipe" });
  const assets = join(out, "assets");
  return { out, files: readdirSync(assets).filter((f) => f.endsWith(".css")).map((f) => join(assets, f)) };
}

/** Rules in file order as `context | selector => decl; decl` (declarations sorted, so only content counts). */
function rules(file) {
  const list = [];
  postcss.parse(readFileSync(file, "utf8")).walkRules((r) => {
    const ctx = [];
    for (let p = r.parent; p && p.type !== "root"; p = p.parent) ctx.unshift(`@${p.name} ${p.params}`);
    const decls = [];
    r.each((n) => n.type === "decl" && decls.push(`${n.prop}:${n.value}${n.important ? "!important" : ""}`));
    list.push({ sel: `${ctx.join(" ")} | ${r.selector.replace(/\s+/g, " ")}`, decls });
  });
  return list;
}
const sig = (r) => `${r.sel} => ${[...r.decls].sort().join("; ")}`;

if (mode === "snapshot" && dir) {
  const { out, files } = builtCss();
  mkdirSync(dir, { recursive: true });
  for (const f of files) copyFileSync(f, join(dir, f.split(/[\/]/).pop()));
  rmSync(out, { recursive: true, force: true });
  console.log(`saved ${files.length} css file(s) to ${dir}`);
} else if (mode === "compare" && dir) {
  const { out, files } = builtCss();
  const before = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => join(dir, f));
  const all = (fs) => fs.flatMap(rules);
  const b = all(before), a = all(files);
  rmSync(out, { recursive: true, force: true });
  // Apply the listed swaps to the "before" rules, then the two lists must hold the same signatures.
  const applied = new Set();
  for (const r of b) r.decls = r.decls.map((d) => {
    for (const [sel, prop, was, now] of VARIABLIZED)
      if (r.sel.endsWith(`| ${sel}`) && d === `${prop}:${was}`) { applied.add(`${sel} { ${prop}: ${was} -> ${now} }`); return `${prop}:${now}`; }
    return d;
  });
  const count = (l) => l.reduce((m, r) => m.set(sig(r), (m.get(sig(r)) ?? 0) + 1), new Map());
  const cb = count(b), ca = count(a);
  let bad = 0;
  for (const [k, n] of cb) if ((ca.get(k) ?? 0) < n) { bad++; console.log(`MISSING ${k}`); }
  for (const [k, n] of ca) if ((cb.get(k) ?? 0) < n) { bad++; console.log(`ADDED   ${k}`); }
  console.log(`rules before ${b.length}, after ${a.length}`);
  console.log(`variable-ized (listed ${VARIABLIZED.length}, applied ${applied.size}):\n  ${[...applied].join("\n  ")}`);
  if (applied.size !== VARIABLIZED.length) { bad++; console.log("a listed variable-ized declaration did not match"); }
  // Order: without the moved block (tile-*) the two sequences must be the same.
  const noTile = (l) => l.map(sig).filter((x) => !/\| \.tile-/.test(x));
  const nb = noTile(b), na = noTile(a);
  const sameOrder = nb.length === na.length && nb.every((x, i) => x === na[i]);
  const at = (l) => l.findIndex((r) => /\| \.tile-card/.test(r.sel));
  console.log(`order: ${sameOrder ? "identical apart from the tile-* block" : "DIFFERENT beyond the tile-* block"}; tile-* block was rule #${at(b)}, now #${at(a)}`);
  if (!sameOrder) bad++;
  console.log(bad ? `DIFFERENT (${bad})` : "IDENTICAL: same set of (selector, declarations) apart from the listed variable-ized ones");
  rmSync(out, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
} else {
  console.log("usage: node scripts/css-rules.mjs snapshot|compare <dir>");
  process.exit(2);
}
