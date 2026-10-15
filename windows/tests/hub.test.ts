import { test } from "node:test";
import assert from "node:assert/strict";
import { diffImport, matchSections, presetModules, PRESETS } from "../src/settings/hub.ts";
import { catalog } from "./catalog.ts";

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
  for (const p of PRESETS) {
    const m = presetModules(cat, p.id);
    assert.deepEqual(Object.keys(m).sort(), cat.map((x) => x.id).sort());
    assert.ok(Object.values(m).some(Boolean), `${p.id} turns something on`);
  }
  const ess = presetModules(cat, "essencial");
  assert.equal(ess.board, true);
  assert.equal(ess.github, false);
  assert.equal(presetModules(cat, "tudo").clock, false, "dev-only module is not in tudo");
  assert.ok(Object.values(presetModules(cat, "vitrine")).every(Boolean));
  assert.ok(Object.values(presetModules(cat, "nao-existe")).every((v) => !v));
});

test("diffImport: top-level diff, secrets and version never applied", () => {
  const cur = { soundVolume: 0.1, screen: "primary", modulesEnabled: { a: true } };
  const file = JSON.stringify({ version: "1", soundVolume: 0.1, screen: "cursor", githubToken: "ghp_LEAK", apiKey: "k", extraKey: 1, modulesEnabled: { a: true } });
  const d = diffImport(cur, file);
  assert.ok(typeof d !== "string");
  assert.deepEqual(d.changes, [{ key: "screen", kind: "alterado" }, { key: "extraKey", kind: "novo" }]);
  assert.deepEqual(d.patch, { screen: "cursor", extraKey: 1 });
  assert.ok(!JSON.stringify(d).includes("LEAK"));
  assert.equal(typeof diffImport(cur, "{oops"), "string");
  assert.equal(typeof diffImport(cur, "[1]"), "string");
});
