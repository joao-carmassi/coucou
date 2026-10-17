// Agentes: off = nothing; a hook event makes the pill; approval only where the agent blocks and approve is on;
// the card sits at 95 under Claude's 100; stopping the module clears the pills and the request.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calls } from "./setup";
import { dummyProbe, requestPin } from "./dummyModule";
import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { State } from "../../src/core/state";
import { buildCatalog } from "../../src/modules/resolve";
import { agents } from "../../src/modules/agents";
import manifest from "../../src/modules/agents/manifest.json";

const ROWS = [
  { id: "codex", label: "Codex", color: "#10b981", installed: true, hooked: true, blocking: true, live: 0, configPath: "x" },
  { id: "gemini", label: "Gemini CLI", color: "#4f8cff", installed: true, hooked: true, blocking: false, live: 0, configPath: "y" },
];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    return cmd === "agents_list" ? ROWS : null;
  },
}));
const handlers = vi.hoisted(() => ({ map: new Map<string, ((e: unknown) => void)[]>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: unknown) => void) => {
    calls.listen.push(name);
    handlers.map.set(name, [...(handlers.map.get(name) ?? []), fn]);
    return () => handlers.map.set(name, (handlers.map.get(name) ?? []).filter((f) => f !== fn));
  },
}));

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const emit = async (payload: object) => {
  (handlers.map.get("agents-hook") ?? []).slice().forEach((f) => f({ payload }));
  await tick(1);
};
const cmds = (name: string) => calls.invoke.filter((c) => c.cmd === name);
const api = () => dummyProbe.api!;
const ask = (agent: string, id: string) => emit({ coucou_agent: agent, hook_event_name: "PermissionRequest", request_id: id, tool_name: "Shell", tool_input: { command: "rm -rf x" } });

beforeAll(async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  const { dummyModule } = await import("./dummyModule");
  const island = new Island(document.getElementById("root")!);
  Registry.init(island, [dummyModule, agents], buildCatalog([{ id: "dummy", label: "Dummy", default: true, order: 200 }, manifest as never], true));
  Registry.apply({ dummy: true, agents: false });
  island.launch();
  await tick(15_000);
});
afterAll(() => vi.useRealTimers());

describe("agents module", () => {
  it("off: no listener, no command, no pill", async () => {
    expect(calls.listen).not.toContain("agents-hook");
    expect(cmds("agents_list")).toHaveLength(0);
    await emit({ coucou_agent: "codex", hook_event_name: "UserPromptSubmit" });
    expect(api().pills.get("agent_codex")).toBeNull();
  });

  it("a hook event creates the pill and Stop removes it later", async () => {
    Registry.apply({ dummy: true, agents: true });
    await tick(5);
    expect(calls.listen).toContain("agents-hook");
    await emit({ coucou_agent: "codex", hook_event_name: "UserPromptSubmit", prompt: "oi" });
    expect(api().pills.get("agent_codex")?.label).toBe("Codex");
    await emit({ coucou_agent: "codex", hook_event_name: "Stop" });
    expect(api().pills.get("agent_codex")).not.toBeNull();
    await tick(5300);
    expect(api().pills.get("agent_codex")).toBeNull();
    // An agent nobody knows is ignored.
    await emit({ coucou_agent: "nope", hook_event_name: "UserPromptSubmit" });
    expect(api().pills.get("agent_nope")).toBeNull();
  });

  it("approve off: the request is declined at once and no card is asked for", async () => {
    State.settings.agentsApprove = false;
    await ask("codex", "r1");
    expect(cmds("agents_decline").map((c) => c.args)).toContainEqual({ requestId: "r1" });
    expect(api().island.busy()).toBe(false);
  });

  it("approve on: a blocking agent gets a pinned card with an ack; a non-blocking one is declined", async () => {
    State.settings.agentsApprove = true;
    await ask("gemini", "g1");
    expect(cmds("agents_decline").map((c) => c.args)).toContainEqual({ requestId: "g1" });
    expect(api().island.busy()).toBe(false);
    await ask("codex", "r2");
    expect(api().island.busy()).toBe(true);
    expect(cmds("agents_ack").map((c) => c.args)).toContainEqual({ requestId: "r2" });
    await tick(50);
    expect(api().island.view()).toBe("agents-approval");
    expect(document.body.textContent).toContain("rm -rf x");
    // A second agent request while one is up goes back to its terminal.
    await ask("codex", "r3");
    expect(cmds("agents_decline").map((c) => c.args)).toContainEqual({ requestId: "r3" });
  });

  it("Claude's card (100) stays in front of the agents' (95)", async () => {
    const over = requestPin(api(), "dummy-a", 0, 100);
    await tick(20);
    expect(api().island.view()).toBe("dummy-a");
    over();
    await tick(20);
    expect(api().island.view()).toBe("agents-approval");
  });

  it("Permitir sends exactly allow and clears the request", async () => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Permitir"))!;
    button.click();
    await tick(5);
    expect(cmds("agents_decide").map((c) => c.args)).toEqual([{ requestId: "r2", word: "allow" }]);
    expect(api().island.busy()).toBe(false);
  });

  it("stopping the module clears pills and declines a waiting request", async () => {
    await emit({ coucou_agent: "codex", hook_event_name: "PreToolUse", tool_name: "Shell" });
    await ask("codex", "r4");
    expect(api().island.busy()).toBe(true);
    Registry.apply({ dummy: true, agents: false });
    await tick(5);
    expect(api().pills.get("agent_codex")).toBeNull();
    expect(api().island.busy()).toBe(false);
    expect(cmds("agents_decline").map((c) => c.args)).toContainEqual({ requestId: "r4" });
  });
});
