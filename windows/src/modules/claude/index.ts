// The Claude Code module: sessions, approval/question/plan cards, finished and error cards,
// the sessions manager and the session panel. Everything it knows lives in its own store
// (store.ts); the core only receives a status line, an avatar signal, a pill, and hooks.

import type { ModuleDef, ViewContext, ViewDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import "./base.css";
import "./chat.css";
import "./claude.css";
import { PANEL_H } from "../../core/moduleApi";
import type { BoardCardOf, BoardFocus, BoardPillOf } from "../board/api";
import { CLAUDE_ID } from "./types";
import { claudeOf } from "./claude";
import { ICONS } from "./icons";
import { CARDS } from "./views/cards";
import { buildClaudeHome, HOME_H } from "./views/home";
import { buildSession } from "./views/session";
import { buildSessionsView } from "./views/sessions";

const view = (
  name: string,
  layout: ViewDef["layout"],
  build: (ctx: ViewContext) => ReturnType<ViewDef["build"]>,
  tabOf?: string,
): ViewDef => ({ name, layout, build, tabOf });

export const claude: ModuleDef = {
  id: "claude",
  views: [
    // Home while the board is off (see the homeView hook below); no tab, so nothing else lights.
    view("claude-home", { height: HOME_H, botX: 68, botY: null, botDiameter: 58 }, (ctx) => buildClaudeHome(claudeOf(ctx.api), ctx)),
    view("approval", { height: 160, botX: 62, botY: null, botDiameter: 56, extraHeight: PANEL_H - 160 },
      (ctx) => CARDS.buildApproval(claudeOf(ctx.api), ctx)),
    // 196 as docs/SPEC.md has it: a question, its options, and a line for what the option under the mouse means.
    view("question", { height: 196, botX: 62, botY: null, botDiameter: 56 },
      (ctx) => CARDS.buildQuestion(claudeOf(ctx.api), ctx)),
    view("error", { height: 160, botX: 62, botY: null, botDiameter: 58 },
      (ctx) => CARDS.buildError(claudeOf(ctx.api), ctx)),
    view("finished", { height: 160, botX: 62, botY: null, botDiameter: 58 },
      (ctx) => CARDS.buildFinished(claudeOf(ctx.api), ctx)),
    // 240 = what the Ask view always was with an empty conversation.
    view("sessions", { height: 240, botX: 52, botY: null, botDiameter: 44 },
      (ctx) => buildSessionsView(claudeOf(ctx.api), ctx)),
    // What a Claude Code session did: the files it changed, each one's diff. Lights the Home tab (the board's).
    view("session", { height: PANEL_H, botX: 67, botY: 108, botDiameter: 71 },
      (ctx) => buildSession(claudeOf(ctx.api), ctx), "overview"),
  ],
  tabs: [
    { view: "sessions", title: "Sessões", icon: () => svg(ICONS.bubble, 13), order: 20 },
  ],
  start(api) {
    const c = claudeOf(api);
    const offs = [
      c.start(),
      // Without the board there is no home tab: the session card is home (github's request has priority 5).
      api.provide("homeView", () => api.use("board.host") === undefined ? { view: "claude-home", priority: 10 } : null),
      // The board (home) asks the owner of each pill: Claude's and the agents' are ours.
      api.provide<BoardCardOf>("board.card", CARDS.boardCardOf(c)),
      api.provide<BoardPillOf>("board.pill", (id) => c.owns(id)
        ? { label: id === CLAUDE_ID ? c.store.clientName : undefined, badge: c.store.badges.get(id) }
        : null),
      api.provide<BoardFocus>("board.focus", (id) => { if (c.owns(id)) c.focusPill(id); }),
    ];
    return () => offs.reverse().forEach((off) => off());
  },
};
