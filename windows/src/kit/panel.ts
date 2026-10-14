// The island panel's frame: an optional side column, and the screen in a darker panel beside it.
//
// Public classes (styled in kit/pane.css)
//   .pane-view        root of a panel view; its animations pause while it is not the view on show (.on)
//   .pane-card        the card holding side + col, laid out as a row
//   .pane-side        left column, starts under the avatar: width --pane-side-w (113px), top padding --pane-side-top (119px)
//   .pane-side-who    two-line heading of the side column: <b> title, <span> sub
//   .pane-col         right column; holds main (and anything stacked over it)
//   .pane-main        the screen: rounded dark panel
//   .pane-head        header strip of main; with .pane-tab (title tab), .pane-head-badge, .pane-head-aside,
//                     .pane-sub (right-hand text, .path for a path), .pane-icon (header button)
//   .pane-list        scrolling list body of main; .pane-empty is its quiet empty line
//   .pane-code        a code/diff body inside main (see kit/code.ts for diff-*)
// API (atoms: one fixed tag + class each)
//   panel({cls?, side?, main})  the whole frame
//   paneHead(...kids) paneTab(...kids) paneSub(cls?) paneBadge() paneAside() paneMain(...kids)
//   paneIcon(attrs, ...kids)  header button; attrs.class is appended to `pane-icon`
//   paneList(cls?) paneCode(cls?, ...kids)  cls is appended after the kit class
//   paneEdge(el, on)  toggles `.pane-edge` on a list;  PANE_MOTION  the entrance classes for replay()
// Rows (.pane-row, .pane-row-*, .pane-ago, .pane-right, .pane-file, .pane-file-status) are built by kit/list.ts.
import { h } from "./dom";

type Part = string | HTMLElement;
type Kids = Node | (Node | null | undefined | false)[];

/** `cls` is the view's own extra class. `side` is omitted for a panel without the left column. */
export function panel(o: { cls?: string; side?: { title: Part; sub?: Part; body?: Node }; main: Kids }): HTMLElement {
  const part = (p: Part, tag: "b" | "span") => (typeof p === "string" ? h(tag, { text: p }) : p);
  const side = o.side && h("div", { class: "pane-side" }, h("div", { class: "pane-side-who" }, part(o.side.title, "b"), o.side.sub != null && part(o.side.sub, "span")), o.side.body);
  const main = Array.isArray(o.main) ? o.main : [o.main];
  return h("div", { class: o.cls ? `view pane-view ${o.cls}` : "view pane-view" }, h("div", { class: "card pane-card" }, side, h("div", { class: "pane-col" }, ...main)));
}

type Kid = string | Node | null | undefined | false;
const withCls = (base: string, cls?: string) => (cls ? `${base} ${cls}` : base);

export const paneHead = (...kids: Kid[]): HTMLElement => h("div", { class: "pane-head" }, ...kids);
export const paneTab = (...kids: Kid[]): HTMLElement => h("div", { class: "pane-tab" }, ...kids);
export const paneSub = (cls?: string): HTMLElement => h("span", { class: withCls("pane-sub", cls) });
export const paneBadge = (): HTMLElement => h("span", { class: "pane-head-badge" });
export const paneAside = (): HTMLElement => h("span", { class: "pane-head-aside" });
export const paneIcon = (attrs: Record<string, string | number | boolean | EventListener | undefined>, ...kids: Kid[]): HTMLElement => {
  const { class: cls, ...rest } = attrs;
  return h("button", { class: withCls("pane-icon", cls as string | undefined), ...rest }, ...kids);
};
export const paneList = (cls?: string): HTMLElement => h("div", { class: withCls("pane-list", cls) });
export const paneMain = (...kids: Kid[]): HTMLElement => h("div", { class: "pane-main" }, ...kids);
export const paneCode = (cls?: string, ...kids: Kid[]): HTMLElement => h("div", { class: withCls("pane-code", cls) }, ...kids);
export const paneEdge = (el: Element, on: boolean): void => void el.classList.toggle("pane-edge", on);
export const PANE_MOTION = { right: "pane-from-right", left: "pane-from-left" } as const;
