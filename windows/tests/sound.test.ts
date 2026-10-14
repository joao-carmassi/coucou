import { test } from "node:test";
import assert from "node:assert/strict";

// Stubs: just enough window / AudioContext / fetch for core/sound.ts.
const g = globalThis as Record<string, unknown>;
g.window = g;
g.location = { href: "http://app.test/", origin: "http://app.test" };
const gates = new Map<string, () => void>();
const fetched: string[] = [];
let created = 0;
g.AudioContext = class {
  state = "running"; destination = {};
  constructor() { created++; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
  createBufferSource() { return { connect() {}, start() { started.push(this.buffer); }, buffer: null as unknown }; }
  decodeAudioData(b: ArrayBuffer) { return Promise.resolve({ id: new TextDecoder().decode(b) }); }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
};
const started: unknown[] = [];
g.fetch = (url: string) => {
  fetched.push(url);
  return new Promise((res) => {
    const done = () => res({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer });
    // /sounds/* resolve now; others wait for gates.get(url)()
    if (url.startsWith("/sounds/")) done(); else gates.set(url, done);
  });
};

const { Sound } = await import("../src/core/sound.ts");
const flush = () => new Promise((r) => setTimeout(r, 0));
const bufs = () => (Sound as unknown as { buffers: Map<string, unknown> }).buffers;

test("a sound registered before preload is loaded by preload; cross-origin is refused", async () => {
  assert.throws(() => Sound.register("x.evil", "http://other.test/a.wav"), /same-origin/);
  Sound.register("m.early", "/mods/early.wav");
  const pre = Sound.preload();
  assert.equal(created, 1);
  gates.get("/mods/early.wav")!();
  await pre;
  assert.ok(bufs().has("m.early"));
  assert.ok(bufs().has("tick"));
});

test("a sound registered during preload (context already exists) is not lost", async () => {
  const off = Sound.register("m.late", "/mods/late.wav");
  gates.get("/mods/late.wav")!();
  await flush();
  assert.ok(bufs().has("m.late"));
  off();
  assert.ok(!bufs().has("m.late"));
});

test("unregister during a load does not resurrect the sound; play waits for a decoding sound once", async () => {
  const off = Sound.register("m.gone", "/mods/gone.wav");
  off();
  gates.get("/mods/gone.wav")!();
  await flush();
  assert.ok(!bufs().has("m.gone"));

  Sound.register("m.slow", "/mods/slow.wav");
  const before = started.length;
  Sound.play("m.slow");
  await flush();
  assert.equal(started.length, before); // still decoding
  gates.get("/mods/slow.wav")!();
  await flush();
  assert.equal(started.length, before + 1);
});
