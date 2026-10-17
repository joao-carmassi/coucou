// Guard: both static audits keep an EMPTY allowlist and pass. Adding an exception means changing this test on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const audit = (name: string, summary: RegExp) => {
  const path = `scripts/${name}.mjs`;
  assert.match(readFileSync(path, "utf8"), /const ALLOWLIST = \[\s*\];/, `${name}: ALLOWLIST must stay empty`);
  const r = spawnSync(process.execPath, [path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, summary);
};

test("idle-audit: empty allowlist, 0 findings", () => audit("idle-audit", /0 finding\(s\), 0 not allowlisted/));
test("neutrality-audit: empty allowlist, 0 findings (incl. K3)", () => audit("neutrality-audit", /TOTAL findings 0, warnings 0, allowlisted 0/));

