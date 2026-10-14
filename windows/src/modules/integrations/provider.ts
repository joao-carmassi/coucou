// One module per service (github, vercel, stripe, n8n, resend, calcom, notion). Plain objects:
// nothing runs at import; heavy views are built in ViewDef.build. Polls are in Rust (events
// `integration`, `secrets-changed`). Cards show in the Claude overview through the `taskCard` /
// `taskNews` hooks, each answering only for its own pill id.

import { PANEL_H } from "../../core/layout";
import "./integrations.css";
import type { ModuleDef } from "../../core/moduleApi";
import { startProvider } from "./controller";
import { PROVIDERS, moduleIdOf, type Provider } from "./providers";
import { buildGithub } from "./views/github";

export function providerModule(def: Provider): ModuleDef {
  const github = moduleIdOf(def) === "github";
  return {
    id: moduleIdOf(def),
    ...(github && {
      views: [{
        name: "github",
        // As tall as the window allows, Mochi in the column on its left (VIEW_LAYOUTS.github at m3-ok).
        layout: { height: PANEL_H, botX: 67, botY: 108, botDiameter: 71 },
        lightsHome: true as const,
        build: buildGithub,
      }],
    }),
    start: (api) => startProvider(api, def),
  };
}

const [github, vercel, stripe, n8n, resend, calcom, notion] = PROVIDERS.map(providerModule);
export { github, vercel, stripe, n8n, resend, calcom, notion };
