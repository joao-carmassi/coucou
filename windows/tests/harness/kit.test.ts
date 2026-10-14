// The kit builders produce the DOM the modules used to write by hand (outerHTML identical).
import { describe, expect, it } from "vitest";
import { dot, h } from "../../src/kit/dom";
import { homeLayout } from "../../src/kit/home";
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

  it("tile draws the dot even for an empty colour, as the old cards did (dot(task.color, 7))", () => {
    const old = h("div", { class: "tile-card" },
      h("div", { class: "tile-head" }, dot("", 7), h("b", { text: "Agent" }), h("span", { text: "Agente" })),
      h("div", { class: "tile-status" }, h("span", { text: "" })));
    expect(tile({ title: "Agent", sub: "Agente", dot: "", status: "" }).outerHTML).toBe(old.outerHTML);
    expect(tile({ title: "A" }).querySelector(".dot")).toBeNull();
  });

  it("panel side.sub is optional", () => {
    expect(panel({ side: { title: "T" }, main: h("div") }).querySelector(".pane-side-who")?.outerHTML).toBe('<div class="pane-side-who"><b>T</b></div>');
  });

  it("homeLayout = the old board literals (board and solo cases)", () => {
    const l = () => h("div", { class: "card" }, h("div", { class: "left-body" }));
    const r = () => h("div", { class: "card" }, h("div", { class: "pills" }));
    const board = h("div", { class: "view overview" }, h("div", { class: "left" }, l()), h("div", { class: "right" }, r()));
    expect(homeLayout({ left: l(), right: r() }).outerHTML).toBe(board.outerHTML);
    const solo = h("div", { class: "view overview solo" }, h("div", { class: "left" }, l()));
    expect(homeLayout({ left: l(), solo: true }).outerHTML).toBe(solo.outerHTML);
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

  it("row = claude's file row (two status columns, empty folder keeps its span)", () => {
    const old = (dir: string) => h("button", { class: "pane-row pane-file", title: "a.ts" },
      h("i", { class: "pane-row-icon" }, h("i", { class: "file-ext", text: "TS" })),
      h("span", { class: "pane-row-title", text: "a.ts" }),
      h("span", { class: "pane-row-where", text: dir }),
      h("span", { class: "pane-right" }, h("span", { class: "pane-file-status", text: "novo" }), h("span", { class: "diff-pm" }), h("span", { class: "pane-ago", text: "2m" })));
    for (const dir of ["", "src/"]) {
      expect(row({ icon: h("i", { class: "file-ext", text: "TS" }), title: "a.ts", where: dir, status: [h("span", { class: "pane-file-status", text: "novo" }), h("span", { class: "diff-pm" })], ago: "2m", cls: "pane-file", attrs: { title: "a.ts" } }).outerHTML).toBe(old(dir).outerHTML);
    }
  });

  it("tile = the agent card and the idle cards of claude and integrations", () => {
    const oldOther = (last: string) => h("div", { class: "tile-card" },
      h("div", { class: "tile-head" }, dot("#88aaff", 7), h("b", { text: "Ag" }), h("span", { text: "Agente" })),
      h("div", { class: "tile-status" }, h("span", { text: last })));
    for (const last of ["", "lendo"]) expect(tile({ title: "Ag", sub: "Agente", dot: "#88aaff", status: last }).outerHTML).toBe(oldOther(last).outerHTML);
    const btn = () => [h("button", { class: "link-btn", text: "Abrir" }), h("button", { class: "link-btn", text: "Configurações…" })];
    const oldIdle = h("div", { class: "tile-card" },
      h("div", { class: "tile-head" }, dot("#d97757", 7), h("b", { text: "Claude Code" }), h("span", { text: "Integração" })),
      h("div", { class: "tile-status" }, dot("#22C55E", 5), h("span", { text: "Conectado" })),
      h("div", { class: "tile-actions" }, ...btn()));
    expect(tile({ title: "Claude Code", sub: "Integração", dot: "#d97757", status: [dot("#22C55E", 5), h("span", { text: "Conectado" })], actions: btn() }).outerHTML).toBe(oldIdle.outerHTML);
  });
});
