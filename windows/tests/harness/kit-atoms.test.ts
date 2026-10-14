// Typed atoms: each one's outerHTML equals the literal a module writes today (shapes copied from the modules).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { card, view } from "../../src/kit/card";
import { diffBlock, plusMinus } from "../../src/kit/code";
import { dot, h, svg } from "../../src/kit/dom";
import { homeBody, homeLayout, setSolo } from "../../src/kit/home";
import { ago, empty, fileStatus, right, rowIcon, rowOf, rowTitle, rowWhere } from "../../src/kit/list";
import { PANE_MOTION, paneAside, paneBadge, paneCode, paneEdge, paneHead, paneIcon, paneList, paneMain, paneSub, paneTab } from "../../src/kit/panel";
import { tileActions, tileCard, tileHead, tileStatus } from "../../src/kit/tile";

const here = dirname(fileURLToPath(import.meta.url));

describe("kit atoms = module literals", () => {
  const ic = () => svg("M0 0", 12, { stroke: 2 });

  it("list atoms (github activity / repo / muted / commit / timed rows, file rows)", () => {
    const act = h("button", { class: "pane-row", title: "t" },
      h("i", { class: "pane-row-icon", style: "color:#fff" }, ic()),
      h("span", { class: "pane-row-title", text: "T" }),
      h("span", { class: "pane-row-where", text: "W" }),
      h("span", { class: "pane-ago", text: "1m" }));
    expect(rowOf("button", { attrs: { title: "t" } }, rowIcon(ic(), "color:#fff"), rowTitle("T"), rowWhere("W"), ago("1m")).outerHTML).toBe(act.outerHTML);
    const repo = h("div", { class: "pane-row" }, dot("#abc", 6), h("span", { class: "pane-row-title", text: "r" }),
      h("span", { class: "pane-right" }, h("b"), h("span", { class: "pane-ago", text: "" })));
    expect(rowOf("div", {}, dot("#abc", 6), rowTitle("r"), right(h("b"), ago(""))).outerHTML).toBe(repo.outerHTML);
    const muted = h("div", { class: "pane-row muted" }, h("i", { class: "pane-row-icon" }, ic()), h("span", { class: "pane-row-where", text: "x" }));
    expect(rowOf("div", { cls: "muted" }, rowIcon(ic()), rowWhere("x")).outerHTML).toBe(muted.outerHTML);
    const commit = h("button", { class: "pane-row" }, h("span", { class: "pane-row-where" }, h("span", { class: "gh-sha", text: "abc" }), " · me"));
    expect(rowOf("button", {}, rowWhere(h("span", { class: "gh-sha", text: "abc" }), " · me")).outerHTML).toBe(commit.outerHTML);
    expect(rowOf("div", { cls: "gh-timed gh-crew" }).outerHTML).toBe(h("div", { class: "pane-row gh-timed gh-crew" }).outerHTML);
    expect(ago("2m", "x").outerHTML).toBe(h("span", { class: "pane-ago x", text: "2m" }).outerHTML);
    expect(fileStatus("novo").outerHTML).toBe(h("span", { class: "pane-file-status", text: "novo" }).outerHTML);
    expect(empty("Nada").outerHTML).toBe(h("div", { class: "pane-empty", text: "Nada" }).outerHTML);
    expect(empty().outerHTML).toBe(h("div", { class: "pane-empty" }).outerHTML);
    const file = h("button", { class: "pane-row pane-file", title: "f" }, h("span", { class: "pane-row-where", text: "" }));
    expect(rowOf("button", { cls: "pane-file", attrs: { title: "f" } }, rowWhere("")).outerHTML).toBe(file.outerHTML);
  });

  it("pane atoms (claude session head / lists / main, github code)", () => {
    const head = h("div", { class: "pane-head" },
      h("button", { class: "pane-icon sess-back", title: "Voltar" }, ic()),
      h("div", { class: "pane-tab" }, h("span", { class: "pane-head-badge" }), h("b", { text: "n" })),
      h("span", { class: "pane-head-aside" }), h("span", { class: "pane-sub" }));
    expect(paneHead(paneIcon({ class: "sess-back", title: "Voltar" }, ic()), paneTab(paneBadge(), h("b", { text: "n" })), paneAside(), paneSub()).outerHTML).toBe(head.outerHTML);
    expect(paneIcon({ title: "Abrir a sessão" }, ic()).outerHTML).toBe(h("button", { class: "pane-icon", title: "Abrir a sessão" }, ic()).outerHTML);
    expect(paneList("sess-journal").outerHTML).toBe(h("div", { class: "pane-list sess-journal" }).outerHTML);
    expect(paneList().outerHTML).toBe(h("div", { class: "pane-list" }).outerHTML);
    expect(paneMain(paneHead(), paneList()).outerHTML).toBe(h("div", { class: "pane-main" }, h("div", { class: "pane-head" }), h("div", { class: "pane-list" })).outerHTML);
    expect(paneCode(undefined, h("div")).outerHTML).toBe(h("div", { class: "pane-code" }, h("div")).outerHTML);
    // claude's literal is "proposed pane-code" (module class first): the atom puts the kit class first, so that one differs
    expect(paneCode("proposed").className).toBe("pane-code proposed");
    const l = paneList();
    paneEdge(l, true);
    expect(l.className).toBe("pane-list pane-edge");
    paneEdge(l, false);
    expect(l.className).toBe("pane-list");
    expect(PANE_MOTION).toEqual({ right: "pane-from-right", left: "pane-from-left" });
  });

  it("tile atoms (integrations header with extra, status, actions)", () => {
    const extra = () => h("button", { class: "link-btn" });
    const oldHead = h("div", { class: "tile-head" }, dot("#7C5CFF", 7), h("b", { text: "Vercel" }), h("span", { text: "Deploys" }), extra());
    expect(tileHead({ dot: "#7C5CFF", title: "Vercel", sub: "Deploys", aside: extra() }).outerHTML).toBe(oldHead.outerHTML);
    expect(tileCard("detail", tileHead({ title: "A" }), tileStatus("x"), tileActions(h("button"))).outerHTML).toBe(
      h("div", { class: "tile-card detail" }, h("div", { class: "tile-head" }, h("b", { text: "A" })), h("div", { class: "tile-status", text: "x" }), h("div", { class: "tile-actions" }, h("button"))).outerHTML);
    expect(tileCard().outerHTML).toBe(h("div", { class: "tile-card" }).outerHTML);
  });

  it("code atoms (code-diff, step preview, plusMinus bare / full)", () => {
    expect(diffBlock().outerHTML).toBe(h("div", { class: "code-diff" }).outerHTML);
    expect(diffBlock("step-preview failed", h("i")).outerHTML).toBe(h("div", { class: "code-diff step-preview failed" }, h("i")).outerHTML);
    const bare = h("span", {}, h("span", { class: "diff-add", text: "+3" }), " ", h("span", { class: "diff-del", text: "−1" }));
    expect(plusMinus(3, 1, true).outerHTML).toBe(bare.outerHTML);
    expect(plusMinus(3, 1).outerHTML).toBe(bare.outerHTML.replace("<span>", '<span class="diff-pm">'));
  });

  it("card / view (plain, wash, wash + chat-card, extra class)", () => {
    expect(card("amber", h("i")).outerHTML).toBe(card({ wash: "amber" }, h("i")).outerHTML);
    expect(card(null).outerHTML).toBe(h("div", { class: "card" }).outerHTML);
    expect(card({ cls: "drop-card" }).outerHTML).toBe(h("div", { class: "card drop-card" }).outerHTML);
    const chat = h("div", { class: "card wash chat-card" }, h("i"));
    chat.style.setProperty("--wash", "rgba(99,102,241,0.5)");
    expect(card({ wash: "indigo", cls: "chat-card" }, h("i")).outerHTML).toBe(chat.outerHTML);
    expect(view(card(null)).outerHTML).toBe(h("div", { class: "view" }, h("div", { class: "card" })).outerHTML);
  });

  it("home: .home class, body, solo", () => {
    expect(homeBody().outerHTML).toBe('<div class="left-body"></div>');
    const el = homeLayout({ left: h("div"), right: h("div") });
    expect(el.className).toBe("view home");
    setSolo(el, true);
    expect(el.className).toBe("view home solo");
    setSolo(el, false);
    expect(el.className).toBe("view home");
  });

  it("home.css is the pre-rename text with .overview -> .home and nothing else", () => {
    // 9ffc7d4 = the commit before the rename
    const before = execSync("git show 9ffc7d4:windows/src/kit/home.css", { cwd: here, encoding: "utf8" });
    const now = readFileSync(join(here, "../../src/kit/home.css"), "utf8");
    const lf = (s: string) => s.replace(/\r\n/g, "\n");
    expect(lf(now)).toBe(lf(before).replace(/\.overview/g, ".home").replace(/`overview`/g, "`home`"));
  });
});
