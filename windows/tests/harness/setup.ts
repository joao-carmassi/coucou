// Environment for the island harness: canvas, Tauri bridge and recorded calls.
import { vi } from "vitest";

export const calls = { invoke: [] as { cmd: string; args?: unknown }[], listen: [] as string[], emit: [] as { event: string; payload: unknown }[] };

/** Looks like a 2d context for anything the code calls: functions are no-ops, props are 0/settable. */
const ctx2d: unknown = new Proxy({}, {
  get: (t: Record<string | symbol, unknown>, k) => {
    if (k in t) return t[k];
    if (k === "measureText") return (s: string) => ({ width: String(s).length * 6 });
    if (k === "createLinearGradient" || k === "createRadialGradient") return () => ({ addColorStop() {} });
    return () => undefined;
  },
  set: (t: Record<string | symbol, unknown>, k, v) => ((t[k] = v), true),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as never;

// IS_TAURI is decided at import time: pretend to be inside Tauri.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.invoke.push({ cmd, args });
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async (_target: string, event: string, payload?: unknown) => {
    calls.emit.push({ event, payload });
  },
  listen: async (name: string) => {
    calls.listen.push(name);
    return () => {};
  },
}));

// Path2D is not in happy-dom; the greeting only builds paths and hands them to the (no-op) context.
(globalThis as unknown as Record<string, unknown>).Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} bezierCurveTo() {} quadraticCurveTo() {} rect() {} ellipse() {} addPath() {} };
