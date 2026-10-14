// The island's home layout: a left card, optionally a right card beside it.
//
// Public classes (styled in kit/home.css): .home (with .solo), .left, .right, .left-body (kit-owned names).
// API
//   homeLayout({left, right?, solo?})  the layout element (`div.view.home[.solo]`)
//   homeBody()                         the `div.left-body` a module puts inside its left card
//   setSolo(el, on)                    toggles `.solo` on a layout: the right slot hides, the left one takes the width
import { h } from "./dom";

/** `left`/`right` are the cards. `solo` hides the right slot; toggle it later with `setSolo`. */
export function homeLayout(o: { left: Node; right?: Node; solo?: boolean }): HTMLElement {
  return h("div", { class: o.solo ? "view home solo" : "view home" },
    h("div", { class: "left" }, o.left),
    o.right && h("div", { class: "right" }, o.right),
  );
}

/** The positioned body of the left card. */
export const homeBody = (): HTMLElement => h("div", { class: "left-body" });

export const setSolo = (el: HTMLElement, on: boolean): void => void el.classList.toggle("solo", on);
