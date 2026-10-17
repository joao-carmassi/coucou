// Media tools: registered as upload.dropAction while the module is on, routed by extension, and the
// `media-tool` listener exists only while a job is in flight.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dummyProbe } from "./dummyModule";

const hub = vi.hoisted(() => ({ handlers: [] as ((e: { payload: unknown }) => void)[], live: 0, invokes: [] as { cmd: string; args?: Record<string, unknown> }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    hub.invokes.push({ cmd, args });
    return cmd === "media_tool_run" ? 7 : cmd === "media_tool_info" ? { sizeText: "1,0 MB", pages: 3 } : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    if (name !== "media-tool") return () => {};
    hub.handlers.push(fn);
    hub.live++;
    let on = true;
    return () => { if (!on) return; on = false; hub.live--; hub.handlers.splice(hub.handlers.indexOf(fn), 1); };
  },
}));

import { Island } from "../../src/island/island";
import { Registry } from "../../src/core/registry";
import { matchDropActions, UPLOAD_SERVICE, type DropAction } from "../../src/modules/upload/api";
import { toolsFor } from "../../src/modules/media/tools";

let island: Island;
const labels = (p: string) => matchDropActions(dummyProbe.api!.useAll<DropAction>(UPLOAD_SERVICE.dropAction), [p]).map((a) => a.label);

beforeAll(async () => {
  vi.useFakeTimers();
  const { dummyModule } = await import("./dummyModule");
  const { media } = await import("../../src/modules/media");
  const { buildCatalog } = await import("../../src/modules/resolve");
  document.body.innerHTML = '<div id="root"></div>';
  island = new Island(document.getElementById("root")!);
  Registry.init(island, [dummyModule, media], buildCatalog([
    { id: "dummy", label: "Dummy", default: true, order: 200 },
    { id: "media", label: "Mídia", default: false, order: 220 },
  ], true));
});
afterAll(() => vi.useRealTimers());

describe("media tools", () => {
  it("offers nothing while off, and chips by extension while on", () => {
    Registry.apply({ dummy: true, media: false });
    expect(labels("C:/a.png")).toEqual([]);
    Registry.apply({ dummy: true, media: true });
    expect(labels("C:/a.png")).toEqual(["Para JPG", "Para WebP", "Reduzir 50%", "Reduzir 25%", "Comprimir", "Sem metadados", "Copiar imagem", "Extrair texto (OCR)"]);
    expect(labels("C:/a.MP4")).toEqual(["Criar GIF", "Comprimir vídeo", "Extrair áudio"]);
    expect(labels("C:/a.pdf")).toEqual(["Info do PDF"]);
    expect(labels("C:/a.zip")).toEqual([]);
    expect(labels("C:\dir.v2\a.PDF")).toEqual(["Info do PDF"]);
    expect(labels("C:\dir.png\README")).toEqual([]);
    expect(toolsFor("x.jpeg").map((t) => t.id)).not.toContain("to-jpg");
  });

  it("listens only while a job runs, then announces and lets go", async () => {
    const png = dummyProbe.api!.useAll<DropAction>(UPLOAD_SERVICE.dropAction).find((a) => a.id === "media.resize-50")!;
    expect(hub.live).toBe(0);
    await png.run(["C:/a.png"]);
    expect(hub.invokes.find((c) => c.cmd === "media_tool_run")!.args).toEqual({ op: "resize", path: "C:/a.png", arg: "50" });
    expect(hub.live).toBe(1);
    hub.handlers[0]({ payload: { id: 7, op: "resize", state: "progress", pct: 40, out: null, text: null, msg: null } });
    hub.handlers[0]({ payload: { id: 7, op: "resize", state: "done", pct: 100, out: "C:/a-50pct.png", text: null, msg: null } });
    expect(hub.live).toBe(0);
  });

  it("stopping the module removes the actions", () => {
    Registry.apply({ dummy: true, media: false });
    expect(labels("C:/a.png")).toEqual([]);
    expect(hub.live).toBe(0);
  });
});
