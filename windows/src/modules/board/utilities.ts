// The "Utilidades" view: every action any running module offers, as a grid. A click runs it through the core
// (api.actions.run: errors go to island.error) and remembers it for the home's "Último" chip.

import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { clear, h } from "../../kit/dom";
import { view } from "../../kit/card";
import { last } from "./last";

export function buildUtilities(ctx: ViewContext): ViewHost {
  const { actions, api } = ctx;
  const grid = h("div", { class: "board-utils" });
  const el = view(h("div", { class: "board-utils-head", text: "Utilidades" }), grid);
  let sig = "";
  return {
    el,
    sync() {
      const list = [...api.actions.all()].sort((a, b) => a.title.localeCompare(b.title, "pt"));
      const next = list.map((a) => `${a.key}|${a.title}|${a.keyHint ?? ""}`).join("\n");
      if (next === sig) return;
      sig = next;
      clear(grid);
      if (!list.length) grid.append(h("div", { class: "board-utils-empty", text: "Nenhuma ação disponível" }));
      for (const a of list) {
        grid.append(h("button", {
          class: "board-util",
          onclick: () => { actions.blip(); last.key = a.key; api.actions.run(a.key); },
        }, h("span", { text: a.title }), a.keyHint ? h("kbd", { text: `Alt+${a.keyHint.toUpperCase()}` }) : null));
      }
    },
  };
}
