import { test } from "node:test";
import assert from "node:assert/strict";
import { diffImport, matchSections, presetModules, presetsOf } from "../src/settings/hub.ts";
import { catalog, manifests } from "./catalog.ts";

test("matchSections: accent and case insensitive, all words must hit", () => {
  const s = [
    { id: "a", title: "Notificações", text: "som e volume" },
    { id: "b", title: "Backup", text: "exportar configurações" },
  ];
  assert.deepEqual(matchSections("NOTIFICACOES", s), ["a"]);
  assert.deepEqual(matchSections("configuracoes exportar", s), ["b"]);
  assert.deepEqual(matchSections("volume backup", s), []);
  assert.deepEqual(matchSections("  ", s), ["a", "b"]);
});

test("presets: set modulesEnabled from catalog data, every id covers the catalog", () => {
  const cat = catalog(true);
  for (const p of presetsOf(cat)) {
    const m = presetModules(cat, p.id);
    assert.deepEqual(Object.keys(m).sort(), cat.map((x) => x.id).sort());
    assert.ok(Object.values(m).some(Boolean), `${p.id} turns something on`);
  }
  const ess = presetModules(cat, "essencial");
  assert.equal(ess.board, true);
  assert.equal(ess.github, false);
  assert.equal(presetModules(cat, "tudo").clock, true, "tudo does not turn the dev-only module off");
  const tudo = presetModules(cat, "tudo");
  const vit = presetModules(cat, "vitrine");
  for (const x of cat) if (x.id !== "demo") assert.ok(tudo[x.id], `tudo includes ${x.id}`);
  for (const id of Object.keys(tudo)) if (tudo[id]) assert.ok(vit[id], `vitrine includes ${id}`);
  assert.ok(Object.values(presetModules(cat, "nao-existe")).every((v) => !v));
});

test("diffImport: top-level diff, secrets and version never applied", () => {
  const cat = catalog(true);
  const cur = { soundVolume: 0.1, screen: "primary", modulesEnabled: { a: true } };
  const file = JSON.stringify({ version: "1", soundVolume: 0.1, screen: "cursor", githubToken: "ghp_LEAK", hooksInstalled: true, wslHooks: ["x"], claudeConfigDir: "C:/x", onboardedVersion: "1", apiKey: "k", extraKey: 1, modulesEnabled: { a: true } });
  const d = diffImport(cur, file, cat);
  assert.ok(typeof d !== "string");
  assert.deepEqual(d.changes, [{ key: "screen", kind: "alterado" }, { key: "extraKey", kind: "novo" }]);
  assert.deepEqual(d.patch, { screen: "cursor", extraKey: 1 });
  assert.ok(!JSON.stringify(d).includes("LEAK"));
  assert.equal(typeof diffImport(cur, "{oops", cat), "string");
  assert.equal(typeof diffImport(cur, "[1]", cat), "string");
});

test("manifests: preset ids are known, essential is boolean, some module is essential", () => {
  const known = new Set(presetsOf(catalog(true)).map((p) => p.id));
  const all = manifests.flat();
  for (const m of all) {
    for (const p of m.presets ?? []) assert.ok(known.has(p), `${m.id}: unknown preset ${p}`);
    assert.ok(m.essential === undefined || typeof m.essential === "boolean", `${m.id}: essential`);
  }
  assert.ok(all.some((m) => m.essential === true), "safe mode needs an essential module");
});

test("diffImport: secret-looking keys are stripped at every depth", () => {
  const file = JSON.stringify({ nested: { apiKey: "k_LEAK", keep: 1, list: [{ Cookie: "c_LEAK", ok: true }] }, plain: 2 });
  const d = diffImport({}, file, catalog(true));
  assert.ok(typeof d !== "string");
  assert.ok(!JSON.stringify(d).includes("LEAK"));
  assert.deepEqual(d.patch, { nested: { keep: 1, list: [{ ok: true }] }, plain: 2 });
});

test("presetsOf: derived from the manifests, known ids first", () => {
  const ids = presetsOf(catalog(true)).map((p) => p.id);
  assert.deepEqual(ids.slice(0, 3), ["essencial", "dev", "tudo"]);
  assert.ok(ids.length >= 3);
});
