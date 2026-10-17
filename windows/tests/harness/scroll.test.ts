// Views whose content can outgrow the island sit in a generic `.scroll` area (style/ui.css), never clipped.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../src/kit/tauri", () => ({ IS_TAURI: true, command: async () => ({}), commandOrThrow: async () => null, onEvent: async () => () => {} }));
const ctx = (view: string) => ({ api: { island: { view: () => view, mode: () => "expanded" }, settings: () => ({}) }, onResize() {}, actions: {} }) as never;

describe("scroll area", () => {
  it("ui.css defines it, with a themed scrollbar", () => {
    const css = readFileSync("src/style/ui.css", "utf8");
    expect(css).toMatch(/\.scroll[^{]*\{[^}]*overflow-y: auto/);
    expect(css).toContain(".scroll::-webkit-scrollbar-thumb");
  });
  it("Pausas and Agenda use it", async () => {
    const { buildView } = await import("../../src/modules/eyecare/view");
    const e = buildView(ctx("eyecare"));
    expect(e.el.querySelector(".scroll.eyecare-view")).not.toBeNull();
    const { buildCalendarView } = await import("../../src/modules/calendar/view");
    const ui = { occs: () => [], tz: () => "UTC", days: () => 7, empty: () => false, error: () => null, busy: () => false, refresh() {}, arm() {} };
    const c = buildCalendarView(ui, ctx("calendar"));
    c.sync();
    expect(c.el.querySelector(".cal-list.scroll")).not.toBeNull();
  });
});
