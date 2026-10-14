import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, moduleIdOf, pillPresent } from "../src/modules/integrations/providers.ts";
import { resolveEnabled } from "../src/core/moduleApi.ts";
import { MODULE_INFO } from "./catalog.ts";

const ids = PROVIDERS.map(moduleIdOf);

test("providers: 7 unique ids, all in the catalog, grouped, in catalog order", () => {
  assert.equal(new Set(ids).size, 7);
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, 7);
  const cat = MODULE_INFO.filter((m) => ids.includes(m.id));
  assert.deepEqual(cat.map((m) => m.id), ids);
  assert.ok(cat.every((m) => m.group === "Integrações" && m.defaultEnabled === false));
  assert.ok(!MODULE_INFO.some((m) => m.id === "integrations"));
});

test("providers: all off by default", () => {
  const on = resolveEnabled(MODULE_INFO, {});
  for (const id of ids) assert.equal(on[id], false);
});

test("providers: pill present = enabled && key present", () => {
  assert.equal(pillPresent(true, true), true);
  assert.equal(pillPresent(true, false), false);
  assert.equal(pillPresent(false, true), false);
});
