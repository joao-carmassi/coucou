// The home view: the focused pill's card on the left (asked of the module that owns the pill), the
// other pills on the right. Moved from the Claude overview; everything pill-specific is a service.

import type { ViewContext, ViewHost } from "../../core/moduleApi";
import type { Pill } from "../../core/state";
import { askPill } from "../../kit/ask";
import { clear, h, svg } from "../../kit/dom";
import { card } from "../../kit/card";
import { last } from "./last";
import { homeBody, homeLayout, setSlim, setSolo } from "../../kit/home";
import { ICONS } from "../../kit/icons";
import { tile } from "../../kit/tile";
import { rt } from "./primary";
import type { BoardCard, BoardCardOf, BoardFocus, BoardPillOf } from "./api";

/** The layout's height (see index.ts). */
export const BOARD_H = 160;

/** What the left slot shows for a pill nobody draws a card for. */
function plainCard(task: Pill): BoardCard {
  return {
    key: [task.id, task.mood, task.label].join("~"),
    build: () => tile({ title: task.label, dot: task.color }),
  };
}

/** Nothing to show: no module has put a pill here. */
function emptyCard(): HTMLElement {
  return tile({ title: "Nada por aqui", status: "O que os módulos ligados fizerem aparece aqui" });
}

export function buildBoard(ctx: ViewContext): ViewHost {
  const { actions, onResize, api } = ctx;
  const askCard = (id: string) => askPill(api.useAll<BoardCardOf>("board.card"), id);
  const askLook = (id: string) => askPill(api.useAll<BoardPillOf>("board.pill"), id);

  const leftBody = homeBody();
  const left = card(null, leftBody);
  const pills = h("div", { class: "pills" });
  const chip = h("div", { class: "board-last" });
  const right = card(null, chip, pills);
  const el = homeLayout({ left, right });

  let shown: BoardCard | null = null;
  let cardKey = "";
  let pillKey = "";
  let room = 0;

  // A card that opens something is clickable as a whole (its own `open`, else the owner's pillOpen); buttons inside keep their own click.
  const opener = (): (() => void) | null => {
    if (shown?.open) return shown.open.bind(shown);
    const id = api.pills.front()?.id;
    return shown?.target && id ? () => void api.call("pillOpen", id) : null;
  };
  left.addEventListener("click", (e) => {
    const open = opener();
    if (!open || (e.target as Element).closest("button")) return;
    actions.blip();
    open();
  });

  const focus = (id: string) => {
    actions.blip();
    if (rt.choose) return rt.choose(id);
    for (const f of api.useAll<BoardFocus>("board.focus")) {
      try { f(id); } catch (err) { console.error("[coucou] pill service failed", err); }
    }
  };

  function buildPill(task: Pill): HTMLElement {
    const look = askLook(task.id);
    const canvas = api.mochi.mini(task, 24);
    const pill = h(
      "div",
      { class: "pill", onclick: () => focus(task.id) },
      canvas,
      h("span", { class: "lbl", text: look?.label ?? task.label }),
    );
    pill.style.borderColor = `${task.color}24`;
    pill.addEventListener("mouseenter", () => {
      pill.style.background = `${task.color}2e`;
      pill.style.borderColor = `${task.color}8c`;
      pill.style.boxShadow = `0 2px 10px ${task.color}59`;
      (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
    });
    pill.addEventListener("mouseleave", () => {
      pill.style.background = "";
      pill.style.borderColor = `${task.color}24`;
      pill.style.boxShadow = "";
      (pill.querySelector(".lbl") as HTMLElement).style.color = "";
    });

    const badgeKind = look?.badge ?? task.badge;
    if (badgeKind) {
      const colors = { alert: "#F5A524", done: "#22C55E", error: "#F4505E" } as const;
      const icons = { alert: ICONS.bang, done: ICONS.check, error: ICONS.xmark } as const;
      const inner = h("i", { style: `background:${colors[badgeKind]}` }, svg(icons[badgeKind], 6, { stroke: badgeKind === "done" ? 3 : 0 }));
      const badge = h("div", { class: "pill-badge" }, inner);
      badge.style.boxShadow = `0 0 4px ${colors[badgeKind]}99`;
      pill.append(badge);
    }
    return pill;
  }

  return {
    el,
    get height() {
      return room ? BOARD_H + room : undefined;
    },
    sync,
  };

  function sync() {
      const task = api.pills.front();
      const next = task ? (askCard(task.id) ?? plainCard(task)) : null;
      const key = next ? `${task!.id}~${next.key}` : "";
      if (key !== cardKey || (!shown && !next && !leftBody.firstChild)) {
        cardKey = key;
        clear(leftBody);
        leftBody.append(!next ? emptyCard() : next.build(actions));
      }
      shown = next;
      shown?.sync?.();
      // The "Último" chip: the last action run from the board, until that action disappears.
      const lastInfo = last.key ? api.actions.all().find((a) => a.key === last.key) : undefined;
      if (!lastInfo) last.key = null;
      chip.textContent = lastInfo ? `Último: ${lastInfo.title}` : "";
      chip.style.display = lastInfo ? "" : "none";

      const nextRoom = shown?.room ?? 0;
      if (nextRoom !== room) {
        room = nextRoom;
        onResize();
      }
      const opens = !!opener();
      left.classList.toggle("opens", opens);
      left.title = opens ? (shown!.hint ?? "") : "";

      const others = api.pills.others().slice(0, 6);
      // Nothing else active: the left card takes the full width. Few others: a narrow right column, one per row.
      setSolo(el, others.length === 0);
      (others.length === 0 ? left : right).prepend(chip); // solo hides the right column
      setSlim(el, others.length > 0 && others.length <= 3);
      pills.dataset.cols = others.length > 3 ? "2" : "1";
      const nextPills = others.map((t) => { const look = askLook(t.id); return `${t.id}:${look?.badge ?? t.badge ?? ""}:${look?.label ?? t.label}`; }).join("|");
      if (nextPills !== pillKey) {
        pillKey = nextPills;
        clear(pills);
        for (const t of others) pills.append(buildPill(t));
      }
  }
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
