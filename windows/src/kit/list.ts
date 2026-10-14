// A row of a panel's list.
//
// Public classes (styled in kit/pane.css)
//   .pane-row         the row (a button): icon, title, where, then the right-hand columns; `.muted` dims it
//   .pane-row-icon    14px icon slot
//   .pane-row-title   the title; keeps its room
//   .pane-row-where   quiet second text (repository, folder); gives way first
//   .pane-right       right-hand columns, lined up from row to row; holds status, counts and .pane-ago
//   .pane-ago         relative time, right-aligned
//   .pane-file        a row that is a file; .pane-file-status is its status word
import { h } from "./dom";

/** The row's button; `cls` adds classes, `attrs` the title / onclick. */
export function row(o: { icon: Node; title: string; where?: string; ago?: string; status?: Node | Node[]; cls?: string; attrs?: Record<string, string | number | boolean | EventListener | undefined> }): HTMLElement {
  const status = o.status == null ? [] : Array.isArray(o.status) ? o.status : [o.status];
  return h("button", { class: o.cls ? `pane-row ${o.cls}` : "pane-row", ...o.attrs },
    h("i", { class: "pane-row-icon" }, o.icon),
    h("span", { class: "pane-row-title", text: o.title }),
    o.where != null && h("span", { class: "pane-row-where", text: o.where }),
    (status.length > 0 || o.ago != null) && h("span", { class: "pane-right" }, ...status, o.ago != null && h("span", { class: "pane-ago", text: o.ago })),
  );
}
