// Integrations on the neutral API: badge set by news, cleared when the pill reaches the front (onChange); board.focus; borrowedFrom-free vercel path.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe } from "./dummyModule";

const handlers: Record<string, (p: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "integrations_secret_present" ? true : null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (p: { payload: unknown }) => void) => ((handlers[name] = fn), () => {}),
}));
const loadModules = async () => {
  const { dummyModule } = await import("./dummyModule");
  const { vercel } = await import("../../src/modules/integrations");
  return { MODULES: [dummyModule, vercel] };
};
const loadCatalog = async () => {
  const { buildCatalog } = await import("../../src/modules/resolve");
  return {
    MODULE_INFO: buildCatalog([
      { id: "dummy", label: "Dummy", default: true, order: 1 },
      { id: "vercel", label: "Vercel", default: true, order: 2 },
    ], true),
  };
};

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";

const dummy = () => dummyProbe.api!;
const flush = () => new Promise((r) => setTimeout(r, 0));
const vercel = () => dummy().pills.get("integration_vercel");

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Registry.init(new Island(document.getElementById("root")!), (await loadModules()).MODULES, (await loadCatalog()).MODULE_INFO);
  Registry.apply({ dummy: true, vercel: true });
  await flush();
});
afterAll(() => Registry.apply({ dummy: false, vercel: false }));

describe("integrations on core/moduleApi", () => {
  it("owns its pill once the key is present", () => {
    expect(vercel()?.label).toBe("Vercel");
  });

  it("idle at start: ambient, so the dummy status keeps the compact island", () => {
    expect(vercel()?.ambient).toBe(true);
    expect(State.gridPills.map((p) => p.id)).not.toContain("integration_vercel");
    expect(State.statusLine?.text).toBe("dummy status");
  });

  it("news badges the pill, board.focus brings it to front and onChange clears the badge", () => {
    vi.useFakeTimers(); // the settle timer armed by this news is advanced below
    handlers["integration"]({ payload: { id: "integration_vercel", data: { x: 1 }, error: null,
      event: { success: true, label: "deploy", detail: "ok" } } });
    expect(vercel()?.badge).toBe("done");
    expect(vercel()?.ambient).toBe(false);
    expect(State.gridPills.map((p) => p.id)).toContain("integration_vercel");
    expect(dummy().pills.front()?.id).toBe("dummy-pill");
    dummy().use<(id: string) => void>("board.focus")!("integration_vercel");
    expect(dummy().pills.front()?.id).toBe("integration_vercel");
    expect(vercel()?.badge ?? null).toBeNull();
  });

  it("settled: ambient again", () => {
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    expect(vercel()?.ambient).toBe(true);
  });

  it("stopping the module keeps the other module's pill", () => {
    Registry.apply({ dummy: true, vercel: false });
    expect(vercel()).toBeNull();
    expect(dummy().pills.get("dummy-pill")).not.toBeNull();
  });
});
