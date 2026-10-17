// Wave 2 additions to the Claude module: finished-card Markdown and chips, live diff, hook fields.
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
import { newSession, newStep, modeName, shortModel } from "../../src/modules/claude/types";
import { CARDS } from "../../src/modules/claude/views/cards";
import { clientOf } from "../../src/modules/claude/hooks";

const cl = () => T.claude as import("../../src/modules/claude/claude").Claude;
const ANSWER = "## Feito\n\n- um `item`\n- <img src=x onerror=alert(1)>\n\n```ts\nconst a = 1;\n```\n\n[site](https://example.com)";

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
  const s = newSession("s1");
  Object.assign(s, { project: "p", state: "done", answer: ANSWER, answeredAt: Date.now() });
  cl().store.sessions = [s];
  cl().store.frontId = "s1";
  cl().store.present();
  cl().api.pills.focus("integration_claude");
});

const finished = () => {
  const host = CARDS.buildFinished(cl(), { onResize() {} } as never);
  host.sync();
  return host.el;
};

describe("finished card", () => {
  it("renders the answer as safe Markdown: text nodes only, links not followed", () => {
    const el = finished();
    const md = el.querySelector(".fin-md") as HTMLElement;
    expect(md.style.display).toBe("");
    expect(md.querySelector(".md-h")?.textContent).toBe("Feito");
    expect(md.querySelector("code")?.textContent).toBe("item");
    expect(md.textContent).toContain("const a = 1;");
    expect(md.querySelector("img")).toBeNull();
    expect(md.querySelector("a")).toBeNull();
    expect(md.textContent).toContain("<img src=x onerror=alert(1)>");
    expect((el.querySelector(".title") as HTMLElement).style.display).toBe("none");
  });

  it("chips: mode, effort and short model, only when known", () => {
    expect(finished().querySelector(".fin-chips")?.childElementCount).toBe(0);
    Object.assign(cl().store.session, { mode: "acceptEdits", effort: "high", model: "claude-opus-4-5-20251001" });
    const chips = [...finished().querySelectorAll(".fin-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["aceitar edições", "high", "Opus 4.5"]);
  });

  it("no answer: the old title line, no body", () => {
    cl().store.session.answer = null;
    cl().store.session.lines = ["Rodou testes"];
    const el = finished();
    expect((el.querySelector(".fin-md") as HTMLElement).style.display).toBe("none");
    expect(el.querySelector(".title")?.textContent).toBe("Rodou testes");
  });
});

describe("helpers", () => {
  it("names", () => {
    expect(modeName("plan")).toBe("plano");
    expect(modeName("weird")).toBe("weird");
    expect(shortModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModel("gpt-x")).toBe("gpt-x");
  });
  it("clientOf", () => {
    expect(clientOf({ entrypoint: "claude-desktop" })).toBe("desktop");
    expect(clientOf({ entrypoint: "cli", term_program: "vscode" })).toBe("vscode");
    expect(clientOf({})).toBe("terminal");
  });
});

describe("board card live diff", () => {
  const edit = (at: number) => {
    const step = newStep("Edit", "edit", "a.ts");
    Object.assign(step, { state: "done", at, patch: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n" });
    return step;
  };
  const box = () => {
    const card = CARDS.boardCardOf(cl())("integration_claude")!;
    const el = card.build({ blip() {} } as never) as HTMLElement;
    card.sync?.();
    return el.querySelector(".now-box") as HTMLElement;
  };
  it("working + fresh edit: diff lines; stale: not live", () => {
    const s = cl().store.session;
    s.state = "working";
    s.answer = null;
    s.steps = [edit(Date.now())];
    expect(box().querySelector(".live-diff .diff-line")).not.toBeNull();
    s.steps = [edit(Date.now() - 60_000)];
    expect(box().querySelector(".live-diff")).toBeNull();
  });
});
