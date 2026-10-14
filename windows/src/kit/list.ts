// A row of a panel's list.
//
// API (each atom is one fixed tag + class; outerHTML equals the literal it replaces)
//   rowOf(tag, {cls?, attrs?}, ...kids)  `pane-row` as a "button" or a "div"; cls is appended, attrs follow the class
//   fileRowOf(attrs, ...kids)  a `rowOf("button")` with the extra `pane-file` class
//   rowIcon(icon, style?)  rowTitle(text)  rowWhere(...kids)  right(...kids)  ago(text, cls?)  fileStatus(text)  empty(text?)
//   row({...})  the usual row, built from the atoms
//
// Public classes (styled in kit/pane.css)
//   .pane-row         the row (a button): icon, title, where, then the right-hand columns; `.muted` dims it
//   .pane-row-icon    14px icon slot
//   .pane-row-title   the title; keeps its room
//   .pane-row-where   quiet second text (repository, folder); gives way first
//   .pane-right       right-hand columns, lined up from row to row; holds status, counts and .pane-ago
//   .pane-ago         relative time, right-aligned
//   .pane-file        a row that is a file; .pane-file-status is its status word
//   .pane-empty       the quiet empty line of a list
import { h } from "./dom";

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Kid = string | Node | null | undefined | false;

export const rowOf = (tag: "button" | "div", o: { cls?: string; attrs?: Attrs }, ...kids: Kid[]): HTMLElement =>
  h(tag, { class: o.cls ? `pane-row ${o.cls}` : "pane-row", ...o.attrs }, ...kids);
/** A `pane-row pane-file` button: a row that is a file. */
export const fileRowOf = (attrs: Attrs, ...kids: Kid[]): HTMLElement => rowOf("button", { cls: "pane-file", attrs }, ...kids);
export const rowIcon = (icon: Node, style?: string): HTMLElement => h("i", { class: "pane-row-icon", style }, icon);
export const rowTitle = (text: string): HTMLElement => h("span", { class: "pane-row-title", text });
export const rowWhere = (...kids: (string | Node)[]): HTMLElement => h("span", { class: "pane-row-where" }, ...kids);
export const right = (...kids: Kid[]): HTMLElement => h("span", { class: "pane-right" }, ...kids);
export const ago = (text: string, cls?: string): HTMLElement => h("span", { class: cls ? `pane-ago ${cls}` : "pane-ago", text });
export const fileStatus = (text: string): HTMLElement => h("span", { class: "pane-file-status", text });
export const empty = (text?: string): HTMLElement => h("div", { class: "pane-empty", text });

/** The row's button; `cls` adds classes, `attrs` the title / onclick. */
export function row(o: { icon: Node; title: string; where?: string; ago?: string; status?: Node | Node[]; cls?: string; file?: boolean; attrs?: Attrs }): HTMLElement {
  const status = o.status == null ? [] : Array.isArray(o.status) ? o.status : [o.status];
  return rowOf("button", { cls: o.file ? (o.cls ? `pane-file ${o.cls}` : "pane-file") : o.cls, attrs: o.attrs },
    rowIcon(o.icon),
    rowTitle(o.title),
    o.where != null && rowWhere(o.where),
    (status.length > 0 || o.ago != null) && right(...status, o.ago != null && ago(o.ago)),
  );
}
