// The card a module draws for a pill in the home's left slot.
//
// Public classes (styled in kit/tile.css; the left padding is --tile-inset, default 108px)
//   .tile-card     the card (add `detail` through `cls` for the detail variant)
//   .tile-head     title row: optional dot, <b> title, optional <span> sub
//   .tile-status   one line under the head
//   .tile-actions  row of buttons under the status
// API
//   tile({title, sub?, dot?, status?, actions?, cls?})  the whole card
//   tileCard(cls?, ...kids)  tileHead({dot?, title, sub?, aside?})  tileStatus(...kids)  tileActions(...kids)  the parts
import { dot as dotEl, h } from "./dom";

type Kids = string | Node | (Node | null | undefined | false)[];
const kids = (k: Kids | undefined) => (k == null ? [] : Array.isArray(k) ? k : [k]);

type Kid = string | Node | null | undefined | false;
export const tileCard = (cls?: string, ...kids: Kid[]): HTMLElement => h("div", { class: cls ? `tile-card ${cls}` : "tile-card" }, ...kids);
/** `dot` is a colour (drawn even when empty); `aside` is appended after the sub. */
export const tileHead = (o: { dot?: string; title: string; sub?: string; aside?: Node }): HTMLElement =>
  h("div", { class: "tile-head" }, o.dot != null && dotEl(o.dot, 7), h("b", { text: o.title }), o.sub != null && h("span", { text: o.sub }), o.aside);
export const tileStatus = (...kids: Kid[]): HTMLElement => h("div", { class: "tile-status" }, ...kids);
export const tileActions = (...kids: Kid[]): HTMLElement => h("div", { class: "tile-actions" }, ...kids);

/** `status` is always drawn (an empty line keeps the card's height); `actions` only when given. */
export function tile(o: { title: string; sub?: string; dot?: string; status?: Kids; actions?: Node[]; cls?: string }): HTMLElement {
  return tileCard(o.cls,
    tileHead(o),
    tileStatus(...kids(o.status).map((k) => (typeof k === "string" ? h("span", { text: k }) : k))),
    o.actions && tileActions(...o.actions),
  );
}
