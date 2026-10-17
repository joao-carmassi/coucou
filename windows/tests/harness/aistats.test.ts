// Estatísticas de IA: nothing runs while off, and nothing runs when on until the view opens.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { buildCatalog } from "../../src/modules/resolve";
import { aistatsModule } from "../../src/modules/aistats";
import manifest from "../../src/modules/aistats/manifest.json";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => { calls.invoke.push({ cmd, args }); return null; },
}));
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const ai = () => calls.invoke.filter((c) => c.cmd.startsWith("aistats_")).length;

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [aistatsModule], buildCatalog([manifest as never], true));
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("aistats module", () => {
  it("does nothing while disabled", async () => {
    Registry.apply({ aistats: false });
    await tick(3600_000);
    expect(ai()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("on without the view: no command, no timer", async () => {
    Registry.apply({ aistats: true });
    const before = vi.getTimerCount();
    await tick(3600_000);
    expect(ai()).toBe(0);
    expect(vi.getTimerCount()).toBe(before);
  });
});
