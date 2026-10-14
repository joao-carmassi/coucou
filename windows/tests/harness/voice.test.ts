// Voice sends its transcript through the claude.launchPrompt service; without it the card shows an error.
import { describe, expect, it, vi } from "vitest";
import type { IslandApi } from "../../src/core/moduleApi";
import { send, Voice } from "../../src/modules/voice/view";

const apiWith = (impl?: (p: string) => Promise<void>) => {
  const asked: string[] = [];
  const api = { use: (k: string) => (k === "claude.launchPrompt" ? impl : undefined), island: { redraw: () => asked.push("redraw") } };
  return { api: api as unknown as IslandApi, asked };
};

describe("voice send", () => {
  it("calls the launchPrompt service and leaves", async () => {
    Voice.reset();
    const leave = vi.fn();
    Voice.leave = leave;
    Voice.text = "  hello  ";
    const launch = vi.fn(async () => {});
    const { api } = apiWith(launch);
    await send(api);
    expect(launch).toHaveBeenCalledWith("hello");
    expect(leave).toHaveBeenCalled();
    expect(Voice.phase).toBe("none");
  });

  it("shows an error when claude is absent", async () => {
    Voice.reset();
    Voice.text = "hello";
    const { api, asked } = apiWith();
    await send(api);
    expect(Voice.phase).toBe("error");
    expect(Voice.note).toMatch(/Claude/);
    expect(asked).toContain("redraw");
    expect(Voice.busy).toBe(false);
  });
});
