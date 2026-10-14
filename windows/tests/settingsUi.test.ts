import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSettingsUi } from "../src/settings/ui.ts";

test("ui.timeout runs, then is a no-op after stop", async () => {
  const s = makeSettingsUi();
  let n = 0;
  s.ui.timeout(() => n++, 5);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 1);
  s.stop();
  s.ui.timeout(() => n++, 5);
  assert.equal(s.timers.size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 1);
});

test("stop cancels pending timers", async () => {
  const s = makeSettingsUi();
  let n = 0;
  s.ui.timeout(() => n++, 10);
  s.stop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 0);
});
