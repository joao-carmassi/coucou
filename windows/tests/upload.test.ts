import { test } from "node:test";
import assert from "node:assert/strict";
import { UploadSeq, USC, uploadProgressCurve } from "../src/modules/upload/sequence.ts";

test("progress curve: 0 to 1, never goes back", () => {
  assert.equal(uploadProgressCurve(0), 0);
  assert.ok(Math.abs(uploadProgressCurve(1) - 1) < 1e-9);
  let prev = 0;
  for (let u = 0; u <= 1; u += 0.01) {
    const p = uploadProgressCurve(u);
    assert.ok(p >= prev - 1e-9);
    prev = p;
  }
});

test("sequence: drop runs only after enterZone; deactivate stops it", () => {
  assert.equal(UploadSeq.isActive, false);
  UploadSeq.enterZone(300, 100);
  assert.equal(UploadSeq.isActive, true);
  assert.equal(UploadSeq.dropped, false);
  UploadSeq.performDrop(2.4);
  assert.equal(UploadSeq.dropped, true);
  assert.ok((UploadSeq.sinceDrop() ?? -1) >= 0);
  assert.ok(USC.T_PROG_START > USC.T_DROP);
  UploadSeq.deactivate();
  assert.equal(UploadSeq.isActive, false);
  assert.equal(UploadSeq.sinceDrop(), null);
});
