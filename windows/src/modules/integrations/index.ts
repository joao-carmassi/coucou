// The integrations module: the GitHub panel, the pills of Resend, n8n, Vercel, GitHub, Notion,
// Cal.com and Stripe, their settings section. Polls are in Rust (events `integration`,
// `secrets-changed`). Off by default. Its cards show in the Claude overview through the
// `taskCard`/`taskNews` hooks, never through an import.

import { PANEL_H } from "../../core/layout";
import type { ModuleDef } from "../../core/moduleApi";
import { startIntegrations } from "./controller";
import { integrationsSettingsSection } from "./settings";
import { buildGithub } from "./views/github";

export const integrations: ModuleDef = {
  id: "integrations",
  label: "Integrações",
  defaultEnabled: false,
  views: [{
    name: "github",
    // As tall as the window allows, Mochi in the column on its left (VIEW_LAYOUTS.github at m3-ok).
    layout: { height: PANEL_H, botX: 67, botY: 108, botDiameter: 71, agentMode: "none" },
    tabOf: "overview",
    build: buildGithub,
  }],
  settings: integrationsSettingsSection,
  start: startIntegrations,
};
