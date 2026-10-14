// Claude's own home, used while the board is off: the card the board would draw for the front Claude pill,
// on a card of its own. Click on it opens the session; the arrow answers pillOpen as in the board.
import type { ViewContext, ViewHost } from "../../../core/moduleApi";
import { card } from "../../../kit/card";
import { clear, h, svg } from "../../../kit/dom";
import { ICONS } from "../../../kit/icons";
import { tile } from "../../../kit/tile";
import type { BoardCard } from "../../board/api";
import type { Claude } from "../claude";
import { CLAUDE_ID } from "../types";
import { CARDS } from "./cards";

/** Same height as the board's home. */
export const HOME_H = 160;

export function buildClaudeHome(c: Claude, ctx: ViewContext): ViewHost {
  const { actions, onResize, api } = ctx;
  const cardOf = CARDS.boardCardOf(c);
  const body = h("div", { class: "left-body" });
  const jump = h("button", { class: "icon-btn jump", title: "Abrir", onclick: () => api.call("pillOpen", api.pills.front()?.id ?? CLAUDE_ID) }, svg(ICONS.arrowUpRight, 8));
  const left = card(null, body, jump);
  const el = h("div", { class: "view overview solo" }, h("div", { class: "left" }, left));
  left.addEventListener("click", (e) => {
    if (!shown?.open || (e.target as Element).closest("button")) return;
    actions.blip();
    shown.open();
  });
  let shown: BoardCard | null = null;
  let key = "";
  let room = 0;
  return {
    el,
    get height() { return room ? HOME_H + room : undefined; },
    sync() {
      const front = api.pills.front();
      const id = front && c.owns(front.id) ? front.id : CLAUDE_ID;
      shown = cardOf(id);
      const next = shown ? `${id}~${shown.key}` : "";
      if (next !== key || !body.firstChild) {
        key = next;
        clear(body);
        body.append(shown ? shown.build(actions) : tile({ title: "Claude Code" }));
      }
      shown?.sync?.();
      jump.style.display = shown?.target ? "" : "none";
      if ((shown?.room ?? 0) !== room) { room = shown?.room ?? 0; onResize(); }
      left.classList.toggle("opens", !!shown?.open);
      left.title = shown?.open ? (shown.hint ?? "") : "";
    },
  };
}
