import { h } from "../../kit/dom";
import { card } from "../../views/views";
import type { ViewHost } from "../../core/moduleApi";

/** The Relógio tab. `sync` runs whenever the view is on screen: that is what arms the clock. */
export function buildClockView(readout: HTMLElement, onSync: () => void): ViewHost {
  const body = h("div", { class: "stack" }, h("div", { class: "title", text: "Relógio" }), readout);
  body.style.padding = "4px 16px 4px 84px";
  return { el: h("div", { class: "view" }, card(null, body)), sync: onSync };
}
