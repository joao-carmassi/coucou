// The Claude Code module: sessions, approval/question/plan cards, finished and error cards,
// the sessions manager and the session panel. Everything it knows lives in its own store
// (store.ts); the core only receives a status line, an avatar signal, a pill, and hooks.

import type { ModuleDef, ViewContext, ViewDef } from "../../core/moduleApi";
import { PANEL_H } from "../../core/layout";
import { svg } from "../../views/dom";
import { claudeOf } from "./claude";
import { ICONS } from "../../views/icons";
import { claudeSettingsSection } from "./settings";
import { CARDS } from "./views/cards";
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
  label: "Claude Code",
  defaultEnabled: true,
  views: [
    view("overview", { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
      (ctx) => CARDS.buildOverview(claudeOf(ctx.api), ctx)),
    view("approval", { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column", proposalRoom: PANEL_H - 160 },
      (ctx) => CARDS.buildApproval(claudeOf(ctx.api), ctx)),
    // 196 as docs/SPEC.md has it: a question, its options, and a line for what the option under the mouse means.
    view("question", { height: 196, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
      (ctx) => CARDS.buildQuestion(claudeOf(ctx.api), ctx)),
    view("error", { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
      (ctx) => CARDS.buildError(claudeOf(ctx.api), ctx)),
    view("finished", { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
      (ctx) => CARDS.buildFinished(claudeOf(ctx.api), ctx)),
    // 240 = what the Ask view always was with an empty conversation.
    view("sessions", { height: 240, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
      (ctx) => buildSessionsView(claudeOf(ctx.api), ctx)),
    // What a Claude Code session did: the files it changed, each one's diff. Lights the Home tab.
    view("session", { height: PANEL_H, botX: 67, botY: 108, botDiameter: 71, agentMode: "none" },
      (ctx) => buildSession(claudeOf(ctx.api), ctx), "overview"),
  ],
  tab: { view: "sessions", title: "Sessões", icon: () => svg(ICONS.bubble, 13), order: 20 },
  settings: claudeSettingsSection,
  start: (api) => claudeOf(api).start(),
};
