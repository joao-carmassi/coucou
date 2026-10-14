// The kit builders produce the DOM the modules used to write by hand (outerHTML identical).
import { describe, expect, it } from "vitest";
import { dot, h } from "../../src/kit/dom";
import { panel } from "../../src/kit/panel";
import { tile } from "../../src/kit/tile";
import { row } from "../../src/kit/list";

describe("kit builders", () => {
  it("tile = board plain card / empty card", () => {
    const oldPlain = h("div", { class: "tile-card" },
      h("div", { class: "tile-head" }, dot("#88aaff", 7), h("b", { text: "Alpha" })),
      h("div", { class: "tile-status" }));
    expect(tile({ title: "Alpha", dot: "#88aaff" }).outerHTML).toBe(oldPlain.outerHTML);
    const oldEmpty = h("div", { class: "tile-card" },
      h("div", { class: "tile-head" }, h("b", { text: "Nada por aqui" })),
      h("div", { class: "tile-status" }, h("span", { text: "O que os módulos ligados fizerem aparece aqui" })));
    expect(tile({ title: "Nada por aqui", status: "O que os módulos ligados fizerem aparece aqui" }).outerHTML).toBe(oldEmpty.outerHTML);
    expect(tile({ title: "A", sub: "B", cls: "detail", actions: [h("button")] }).outerHTML)
      .toContain('<div class="tile-head"><b>A</b><span>B</span></div><div class="tile-status"></div><div class="tile-actions"><button></button></div>');
  });

  it("panel = the old markup literal", () => {
    const main = () => h("div", { class: "pane-main" }, h("div", { class: "pane-head" }));
    const mk = () => ({ name: h("b", { text: "x" }), sub: h("span", { text: "y" }), steps: h("div", { class: "sess-steps" }) });
    const old = (({ name, sub, steps }) => {
      const side = h("div", { class: "pane-side" }, h("div", { class: "pane-side-who" }, name, sub), steps);
      return h("div", { class: "view pane-view session-view" }, h("div", { class: "card pane-card" }, side, h("div", { class: "pane-col" }, main())));
    })(mk());
    const { name, sub, steps } = mk();
    expect(panel({ cls: "session-view", side: { title: name, sub, body: steps }, main: main() }).outerHTML).toBe(old.outerHTML);
    const nt = () => h("div", { class: "gh-notice-slot" });
    const oldGh = h("div", { class: "view pane-view" }, h("div", { class: "card pane-card" },
      h("div", { class: "pane-side" }, h("div", { class: "pane-side-who" }, h("b", { text: "Mídia" }), h("span", { text: "z" }))),
      h("div", { class: "pane-col" }, nt(), main())));
    expect(panel({ side: { title: "Mídia", sub: "z" }, main: [nt(), main()] }).outerHTML).toBe(oldGh.outerHTML);
    expect(panel({ main: main() }).querySelector(".pane-side")).toBeNull();
  });

  it("row = the old pane-row markup", () => {
    const old = h("button", { class: "pane-row sess-row", title: "t" },
      h("i", { class: "pane-row-icon" }, dot("#fff", 7)),
      h("span", { class: "pane-row-title", text: "T" }),
      h("span", { class: "pane-row-where", text: "W" }),
      h("span", { class: "pane-right" }, h("b", { text: "s" }), h("span", { class: "pane-ago", text: "1m" })));
    expect(row({ icon: dot("#fff", 7), title: "T", where: "W", status: h("b", { text: "s" }), ago: "1m", cls: "sess-row", attrs: { title: "t" } }).outerHTML).toBe(old.outerHTML);
  });
});
