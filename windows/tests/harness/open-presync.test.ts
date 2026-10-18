// Opening a card whose height is measured on sync is one movement: the springs get one target, not two.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { Island } from "../../src/island/island";

beforeAll(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
});
afterAll(() => vi.useRealTimers());

describe("open pre-sync", () => {
  it("measures the destination view before aiming the height spring", () => {
    const island = new Island(document.getElementById("root")!);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i = island as any;
    let h: number | undefined;
    const el = document.createElement("div");
    i.views.set("fake", { el, sync() { if (h !== 300) { h = 300; island.layoutHint(); } }, get height() { return h; } });
    island.launch();
    vi.advanceTimersByTime(1000);
    const spy = vi.spyOn(i.height, "springTo");
    island.expand("fake" as never);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeGreaterThanOrEqual(300);
  });
});
