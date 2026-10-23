// A finished session always opens its card (even behind another session or pill), except while the
// front session waits for an answer; a Stop with subagents still going (or from inside one) opens none.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleDef } from "../../src/core/moduleApi";

const T = vi.hoisted(() => ({ claude: null as unknown }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../../src/modules/claude/claude", async (orig) => {
  const real = await orig<typeof import("../../src/modules/claude/claude")>();
  return { ...real, claudeOf: (api: never) => ((T.claude = real.claudeOf(api)), T.claude) };
});

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { handleHook, type HookPayload } from "../../src/modules/claude/hooks";

const cl = () => T.claude as import("../../src/modules/claude/claude").Claude;
const hook = (session_id: string, hook_event_name: string, extra: Partial<HookPayload> = {}) =>
  handleHook(cl(), { session_id, hook_event_name, cwd: "C:/p", ...extra });
const finishedOpen = () => cl().api.island.mode() === "expanded" && cl().api.island.view() === "finished";
const reset = () => {
  vi.advanceTimersByTime(30_000);
  cl().api.island.close();
  vi.advanceTimersByTime(5_000);
};

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const island = new Island(document.getElementById("root")!);
  const { buildCatalog } = await import("../../src/modules/resolve");
  const { claude } = await import("../../src/modules/claude");
  Registry.init(island, [claude as ModuleDef], buildCatalog([{ id: "claude", label: "Claude", default: true, order: 1 }], true));
  Registry.apply({ claude: true });
  island.launch();
  vi.advanceTimersByTime(15_000);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  const c = cl();
  c.store.sessions = [];
  c.store.frontId = "";
  c.syncRequest(false); // drops the pinned request a previous case left
  c.api.pills.remove("other");
  c.setFocus("integration_claude");
  reset();
  // s1 in front and at work, s2 behind
  hook("s1", "UserPromptSubmit", { prompt: "oi" });
  hook("s2", "UserPromptSubmit", { prompt: "oi" });
  hook("s1", "PreToolUse", { tool_name: "Read", tool_input: { file_path: "a" } });
  reset();
});

describe("finished card", () => {
  it("a session behind the front one finishes: it takes the front and opens its card", () => {
    expect(cl().store.frontId).toBe("s1");
    hook("s2", "Stop", { last_message: "pronto" });
    expect(cl().store.frontId).toBe("s2");
    expect(finishedOpen()).toBe(true);
  });

  it("subagents still running: no card; the last Stop opens it", () => {
    hook("s1", "Stop", { background_tasks: [{ type: "subagent", status: "running" }] });
    expect(finishedOpen()).toBe(false);
    expect(cl().store.session.state).toBe("working");
    expect(cl().store.session.agentsRunning).toBe(1);
    hook("s1", "Stop", { background_tasks: [] });
    expect(finishedOpen()).toBe(true);
  });

  it("a shell in the background does not hold the card back", () => {
    hook("s1", "Stop", { background_tasks: [{ type: "shell", status: "running" }] });
    expect(finishedOpen()).toBe(true);
  });

  it("a Stop from inside a subagent: no card, and it does not take the front", () => {
    hook("s2", "Stop", { agent_id: "a1" });
    expect(finishedOpen()).toBe(false);
    expect(cl().store.frontId).toBe("s1");
  });

  it("the front session waits for approval: another one's Stop leaves the approval alone", () => {
    hook("s1", "PermissionRequest", { request_id: "r1", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(cl().api.island.view()).toBe("approval");
    hook("s2", "Stop", { last_message: "pronto" });
    expect(cl().store.frontId).toBe("s1");
    expect(cl().api.island.view()).toBe("approval");
    expect(cl().store.sessions.find((s) => s.id === "s2")?.news).toBe("done");
  });

  it("another pill in front: the Stop brings Claude's pill forward and opens the card", () => {
    cl().api.pills.set({ id: "other", label: "Outro", color: "#10b981", mood: "idle" });
    cl().api.pills.focus("other");
    expect(cl().focusId()).toBe("other");
    hook("s2", "Stop", { last_message: "pronto" });
    expect(cl().focusId()).toBe("integration_claude");
    expect(finishedOpen()).toBe(true);
  });
});
