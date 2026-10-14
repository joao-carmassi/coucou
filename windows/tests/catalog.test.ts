import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, collectDefs } from "../src/modules/resolve.ts";
import { catalog, manifests } from "./catalog.ts";

test("catalog: sorted by order then id, devOnly only in dev", () => {
  const m = (id: string, order: number, devOnly?: boolean) => ({ id, label: id, default: false, order, devOnly });
  const files = [m("b", 2), [m("z", 1), m("a", 2)], m("d", 0, true)];
  assert.deepEqual(buildCatalog(files, false).map((x) => x.id), ["z", "a", "b"]);
  assert.deepEqual(buildCatalog(files, true).map((x) => x.id), ["d", "z", "a", "b"]);
});

test("catalog: shipped manifests are consistent", () => {
  const ids = catalog(true).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.ok(manifests.length > 0);
  ids.forEach((id, i) => {
    for (const r of catalog(true)[i].requires ?? []) assert.ok(ids.indexOf(r) >= 0 && ids.indexOf(r) < i, `${id} requires ${r} earlier`);
  });
  assert.deepEqual(catalog(false).map((x) => x.id).slice(0, 5), ["claude", "media", "timer", "upload", "voice"]);
});

test("collectDefs: keeps module-looking exports only", () => {
  const def = { id: "x", start() {} };
  assert.deepEqual(collectDefs([{ def, n: 3, s: "a", f() {} }]), [def]);
});
