import { test } from "node:test";
import assert from "node:assert/strict";
import { Compact } from "../src/core/compact.ts";
import { focusMs } from "../src/core/holds.ts";
import { BAND } from "../src/core/moduleApi.ts";
import { releaseCandidate, sourceLines, type Src } from "../src/core/sources.ts";

const src = (owner: string, key: string, text: string | null, view = "v"): Src =>
  ({ id: `${owner}.${key}`, owner, def: { label: key, view }, line: text === null ? null : { priority: 1, text } });

const OWNERS = ["#pin", "#last", "agent", "voice", "timer", "#notice"];
/** What the compact island says with these sources and lines. */
function shown(srcs: Src[], pinned: string, last: string | null, others: Record<string, { priority: number; text: string; overGrid?: boolean; urgent?: boolean }> = {}, pills = 0) {
  OWNERS.forEach((o) => Compact.set(o, null));
  const { pin, last: l } = sourceLines(srcs, pinned, last);
  Compact.set("#pin", pin);
  Compact.set("#last", l);
  for (const [o, line] of Object.entries(others)) Compact.set(o, line);
  return Compact.resolve(pills)?.text ?? null;
}

test("focusMs: the one focus time is the hide interval; never-hide uses 60 s", () => {
  assert.equal(focusMs(60), 60_000);
  assert.equal(focusMs(30), 30_000);
  assert.equal(focusMs(0), 60_000);
  assert.equal(focusMs(-5), 60_000);
});

test("pinned beats an agent working line (30) and sits below voice, timer, notice, finished, urgent, with or without other pills", () => {
  const s = [src("w", "now", "pinned")];
  assert.equal(BAND.PINNED > BAND.ACTIVE && BAND.PINNED < 40, true);
  for (const pills of [0, 2]) {
    assert.equal(shown(s, "w.now", null, { agent: { priority: 30, text: "working" } }, pills), "pinned");
    // none of these is overGrid: they pass over the pinned line by priority alone
    for (const [p, name] of [[40, "voice"], [60, "agent"]] as const)
      assert.equal(shown(s, "w.now", null, { [name]: { priority: p, text: `p${p}` } }, pills), `p${p}`);
    assert.equal(shown(s, "w.now", null, { agent: { priority: 90, text: "ask", urgent: true } }, pills), "ask");
    assert.equal(shown(s, "w.now", null, { agent: { priority: 100, text: "approve", urgent: true } }, pills), "approve");
  }
  assert.equal(shown(s, "w.now", null, { timer: { priority: 50, text: "05:00", overGrid: true }, "#notice": { priority: 60, text: "n", overGrid: true } }, 2), "n");
});

test("without a pinned line the old rule stands: a line that is not overGrid is hidden by other pills", () => {
  assert.equal(shown([], "", null, { voice: { priority: 40, text: "v" } }, 2), null);
  assert.equal(shown([], "", null, { agent: { priority: 100, text: "a", urgent: true } }, 2), "a");
});

test("pinned shows beside other pills (overGrid); a last-opened line does not", () => {
  const s = [src("w", "now", "pinned"), src("n", "track", "song")];
  assert.equal(shown(s, "w.now", null, {}, 2), "pinned");
  assert.equal(shown(s, "", "n", {}, 2), null);
  assert.equal(shown(s, "", "n", {}, 0), "song");
});

test("only the pinned id counts: an unpinned source is never shown by pinning, another id replaces", () => {
  const s = [src("w", "now", "W"), src("n", "track", "N")];
  assert.equal(shown(s, "n.track", null), "N");
  assert.equal(shown(s, "w.now", null), "W");
  assert.equal(shown(s, "", null), null);
  assert.equal(shown(s, "gone.x", null), null); // pinned module absent: ignored
});

test("last-opened: the opened module's first source with content, below working lines, pinned wins", () => {
  const s = [src("n", "a", null), src("n", "b", "N-b"), src("w", "now", "W")];
  assert.equal(shown(s, "", "n"), "N-b");
  assert.equal(shown(s, "", "n", { agent: { priority: 30, text: "working" } }), "working");
  assert.equal(shown(s, "w.now", "n"), "W");
  assert.equal(shown(s, "", null), null);
  assert.equal(shown([src("n", "a", null)], "", "n"), null, "no content, no line");
});

test("source lines get the source's view and ignore their own priority and ttl", () => {
  const { pin } = sourceLines([{ ...src("w", "now", "x", "weather"), line: { priority: 99, text: "x", ttlMs: 5 } }], "w.now", null);
  assert.equal(pin?.priority, BAND.PINNED);
  assert.equal(pin?.view, "weather");
  assert.equal(pin?.ttlMs, undefined);
});

test("releaseCandidate: only a pinned source that exists without content", () => {
  assert.equal(releaseCandidate([src("w", "now", null)], "w.now"), "w.now");
  assert.equal(releaseCandidate([src("w", "now", "x")], "w.now"), null);
  assert.equal(releaseCandidate([], "w.now"), null);
  assert.equal(releaseCandidate([src("w", "now", null)], ""), null);
});
