// Voice sends its transcript through the claude.launchPrompt service; without it the same Enter copies the text.
import { describe, expect, it, vi } from "vitest";
import type { IslandApi } from "../../src/core/moduleApi";
import { bindFlow } from "../../src/modules/voice/flow";
import { send, speakHint, Voice } from "../../src/modules/voice/view";

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

  it("copies the text when claude is absent, without throwing", async () => {
    Voice.reset();
    const leave = vi.fn();
    Voice.leave = leave;
    Voice.text = "hello";
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { api } = apiWith();
    await send(api);
    vi.unstubAllGlobals();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(leave).toHaveBeenCalled();
    expect(Voice.phase).toBe("none");
    expect(Voice.busy).toBe(false);
  });

  it("shows the error when the copy is refused", async () => {
    Voice.reset();
    Voice.text = "hello";
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("negado"); } } });
    const { api, asked } = apiWith();
    await send(api);
    vi.unstubAllGlobals();
    expect(Voice.phase).toBe("error");
    expect(Voice.note).toBe("negado");
    expect(asked).toContain("redraw");
    expect(Voice.busy).toBe(false);
  });
});

describe("voice hint", () => {
  it("is English-only for the light engine and follows the language for whisper", () => {
    expect(speakHint("whistle", "pt")).toBe("Fale em inglês");
    expect(speakHint("whisper", "pt")).toBe("Fale em português");
    expect(speakHint("whisper", "auto")).toBe("Fale no seu idioma");
  });
});

describe("voice flow", () => {
  const fake = (enabled: () => boolean) => {
    const handlers: Record<string, (p: unknown) => void> = {};
    const listened: string[] = [];
    const api = {
      settings: () => ({ voiceFlowEnabled: enabled() }),
      listen: (name: string, fn: (p: unknown) => void) => { listened.push(name); handlers[name] = fn; return () => { delete handlers[name]; }; },
      timeout: (fn: () => void) => { fn(); return () => {}; },
      avatar: { level: vi.fn() },
    };
    return { api: api as unknown as IslandApi, handlers, listened };
  };

  it("with the setting off no voice-flow listener runs and no command is called", () => {
    Voice.reset();
    const { api, listened } = fake(() => false);
    const line = vi.fn();
    const off = bindFlow(api, { line, error: vi.fn() });
    expect(listened).not.toContain("voice-flow");
    expect(line).not.toHaveBeenCalled();
    off();
  });

  it("follows the setting, shows the status while dictating and reports a failure", () => {
    Voice.reset();
    let on = false;
    const { api, handlers, listened } = fake(() => on);
    const line = vi.fn();
    const error = vi.fn();
    const off = bindFlow(api, { line, error });
    on = true;
    handlers["settings-changed"](null);
    expect(listened).toContain("voice-flow");
    handlers["voice-flow"]({ state: "listening", chars: 0, message: "" });
    expect(Voice.flow).toBe("listening");
    handlers["voice-flow"]({ state: "pasted", chars: 5, message: "" });
    expect(Voice.flow).toBe("");
    handlers["voice-flow"]({ state: "error", chars: 0, message: "falhou" });
    expect(error).toHaveBeenCalledWith("falhou");
    on = false;
    handlers["settings-changed"](null);
    expect(handlers["voice-flow"]).toBeUndefined();
    off();
  });
});
