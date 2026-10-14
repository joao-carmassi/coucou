// The card a module draws for a pill in the home's left slot.
//
// Public classes (styled in kit/tile.css; the left padding is --tile-inset, default 108px)
//   .tile-card     the card (add `detail` through `cls` for the detail variant)
//   .tile-head     title row: optional dot, <b> title, optional <span> sub
//   .tile-status   one line under the head
//   .tile-actions  row of buttons under the status
import { dot as dotEl, h } from "./dom";

type Kids = string | Node | (Node | null | undefined | false)[];
const kids = (k: Kids | undefined) => (k == null ? [] : Array.isArray(k) ? k : [k]);

/** `status` is always drawn (an empty line keeps the card's height); `actions` only when given. */
export function tile(o: { title: string; sub?: string; dot?: string; status?: Kids; actions?: Node[]; cls?: string }): HTMLElement {
  return h("div", { class: o.cls ? `tile-card ${o.cls}` : "tile-card" },
    h("div", { class: "tile-head" }, o.dot && dotEl(o.dot, 7), h("b", { text: o.title }), o.sub != null && h("span", { text: o.sub })),
    h("div", { class: "tile-status" }, ...kids(o.status).map((k) => (typeof k === "string" ? h("span", { text: k }) : k))),
    o.actions && h("div", { class: "tile-actions" }, ...o.actions),
  );
}
