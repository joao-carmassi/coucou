// The island's home layout: a left card, optionally a right card beside it.
//
// Public classes (styled in kit/home.css): .overview (with .solo), .left, .right, .left-body (kit-owned names).
import { h } from "./dom";

/** `left`/`right` are the cards. `solo` hides the right slot; toggle `.solo` on the result later to change it. */
export function homeLayout(o: { left: Node; right?: Node; solo?: boolean }): HTMLElement {
  return h("div", { class: o.solo ? "view overview solo" : "view overview" },
    h("div", { class: "left" }, o.left),
    o.right && h("div", { class: "right" }, o.right),
  );
}
