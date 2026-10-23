// Pausas: nothing runs while off; on = one reminder timeout, no polling; a stop clears it. A reminder opens a card to confirm.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { Requests } from "../../src/core/requests";
import { buildCatalog } from "../../src/modules/resolve";
import { eyecareModule } from "../../src/modules/eyecare";
import manifest from "../../src/modules/eyecare/manifest.json";

const os = vi.hoisted(() => ({ idle: 1000, quiet: false }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    return cmd === "eyecare_checkpoint" ? { idle: os.idle, quiet: os.quiet } : null;
  },
}));

const handlers = vi.hoisted(() => ({ list: [] as (() => void)[] }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: () => void) => {
    if (name === "settings-changed") handlers.list.push(fn);
    return () => { handlers.list = handlers.list.filter((h) => h !== fn); };
  },
}));
const changed = async () => { handlers.list.slice().forEach((f) => (f as (e: unknown) => void)({ payload: {} })); await tick(1); };
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const until = async (cond: () => boolean) => { for (let i = 0; i < 240 && !cond(); i++) await tick(30_000); };
const eye = () => calls.invoke.filter((c) => c.cmd.startsWith("eyecare_")).length;
const onCard = () => State.mode === "expanded" && State.view === "eyecare-break";
/** The break card's text while it is on screen (an answered card keeps its text, folded away). */
const cardText = () => (onCard() ? document.querySelector(".eyecare-ask")?.textContent ?? "" : "");
/** Answered, expired or paused: no request left, and the island is not left open on the spent card. */
const gone = () => { expect(Requests.busy()).toBe(false); expect(onCard()).toBe(false); };
const marks = (from = 0) => calls.invoke.slice(from).filter((c) => c.cmd === "eyecare_break").map((c) => (c.args as { taken: boolean }).taken);
const press = (label: string) => (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLElement).click();

let island: Island;
beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [eyecareModule], buildCatalog([manifest as never], true));
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("eyecare module", () => {
  it("does nothing while disabled", async () => {
    Registry.apply({ eyecare: false });
    await tick(3 * 3600_000);
    expect(eye()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms one timeout, fires a checkpoint and a card; nothing counts until answered", async () => {
    State.settings.eyecareInterval = 20;
    Registry.apply({ eyecare: true });
    await tick(19 * 60_000);
    expect(eye()).toBe(0);
    await tick(61_000);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint")).toHaveLength(1);
    expect(cardText()).toContain("Descanse os olhos");
    expect(marks()).toEqual([]);
    island.onCursor(360, 20); // the mouse is on the island, as it is for a click
    press("Fiz a pausa");
    expect(marks()).toEqual([true]);
    await tick(10);
    gone();
    island.onCursor(-10_000, -10_000);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
  });

  it("the card's text keeps clear of Mochi", () => {
    const l = eyecareModule.views!.find((v) => v.name === "eyecare-break")!.layout;
    const pad = Number(/\.eyecare-ask \{[^}]*padding: \d+px \d+px \d+px (\d+)px/.exec(readFileSync("src/modules/eyecare/eyecare.css", "utf8"))?.[1]);
    // The card starts 10 px into the island; Mochi's body draws a few px wider than its diameter, more when it squashes.
    expect(l.botX + l.botDiameter / 2 + 12).toBeLessThanOrEqual(10 + pad);
  });

  it("an unanswered card expires after 2 min as not taken; Agora nao is not taken either", async () => {
    State.settings.eyecareKinds = ["water"];
    const n = calls.invoke.length;
    await tick(20 * 60_000 + 100);
    expect(cardText()).toContain("Beba");
    await tick(2 * 60_000);
    expect(marks(n)).toEqual([false]);
    gone();
    await until(onCard); // a fixed 20 min would land after this card's own 2 min expiry
    expect(cardText()).toContain("Beba");
    press("Agora não");
    expect(marks(n)).toEqual([false, false]);
    await tick(10);
    gone();
  });

  it("pause drops the card without counting the round", async () => {
    const n = calls.invoke.length;
    await until(onCard);
    State.setPaused(true);
    await tick(10);
    expect(marks(n)).toEqual([]);
    gone();
    State.setPaused(false);
  });

  it("quiet: waits and retries every 2 min without counting or advancing the kind", async () => {
    State.settings.eyecareKinds = ["eyes", "water"];
    os.quiet = true;
    const n = calls.invoke.length;
    const c = () => calls.invoke.slice(n).filter((x) => x.cmd === "eyecare_checkpoint").length;
    await until(() => c() === 1);
    await tick(2 * 60_000 - 30_000);
    expect(c()).toBe(1);
    await tick(30_000 + 100);
    expect(c()).toBe(2);
    os.quiet = false;
    await tick(2 * 60_000);
    expect(c()).toBe(3);
    expect(marks(n)).toEqual([]);
    expect(cardText()).toMatch(/Descanse|alongar|Beba/);
    const kind = /Descanse|alongar|Beba/.exec(cardText())![0];
    press("Fiz a pausa");
    expect(marks(n)).toEqual([true]);
    expect(kind).toBeTruthy();
  });

  it("idle 5 min+ counts as taken without a card; idle >= interval + 5 min is skipped; stop leaves nothing armed", async () => {
    State.settings.eyecareKinds = ["water"];
    const n = calls.invoke.length;
    os.idle = 6 * 60_000;
    await until(() => marks(n).length === 1);
    expect(marks(n)).toEqual([true]);
    expect(cardText()).not.toContain("Beba");
    os.idle = 25 * 60_000;
    const c = calls.invoke.filter((x) => x.cmd === "eyecare_checkpoint").length;
    await until(() => calls.invoke.filter((x) => x.cmd === "eyecare_checkpoint").length > c);
    await tick(1000);
    expect(marks(n)).toEqual([true]);
    Registry.apply({ eyecare: false });
    const after = eye();
    await tick(3 * 3600_000);
    expect(eye()).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interval 0 arms nothing", async () => {
    State.settings.eyecareInterval = 0;
    Registry.apply({ eyecare: true });
    const t = vi.getTimerCount();
    const e = eye();
    await tick(3 * 3600_000);
    expect(eye()).toBe(e);
    expect(vi.getTimerCount()).toBe(t);
    Registry.apply({ eyecare: false });
  });

  it("0 -> 20 arms a timer; 20 -> 0 stops the next reminder", async () => {
    State.settings.eyecareInterval = 0;
    State.settings.eyecareKinds = ["eyes"];
    os.idle = 1000;
    Registry.apply({ eyecare: true });
    await tick(5);
    State.settings.eyecareInterval = 20;
    await changed();
    const n = calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length;
    await tick(20 * 60_000 + 100);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length).toBe(n + 1);
    State.settings.eyecareInterval = 0;
    await changed();
    await tick(3 * 3600_000);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length).toBe(n + 1);
    expect(vi.getTimerCount()).toBe(0);
    Registry.apply({ eyecare: false });
  });

  it("20 -> 30 updates the tile text and rearms with 30 min", async () => {
    State.settings.eyecareInterval = 20;
    os.idle = 1000;
    Registry.apply({ eyecare: true });
    await tick(5);
    expect(document.body.textContent).toContain("lembrete a cada 20 min");
    State.settings.eyecareInterval = 30;
    await changed();
    expect(document.body.textContent).toContain("lembrete a cada 30 min");
    const n = calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length;
    await tick(25 * 60_000);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length).toBe(n);
    await tick(5 * 60_000 + 100);
    expect(calls.invoke.filter((c) => c.cmd === "eyecare_checkpoint").length).toBe(n + 1);
    Registry.apply({ eyecare: false });
  });
});
