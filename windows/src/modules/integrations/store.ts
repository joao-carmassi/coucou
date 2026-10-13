// What the integrations module knows while it runs. Module-level, reset on every start; the
// core never sees it (it gets pills, hooks and a view). The views reach the island through `rt`.

import type { Disposer, IslandApi } from "../../core/moduleApi";
import type { IntegrationNews } from "../../core/bridge";
import { State } from "../../core/state";

export const GITHUB = "integration_github";

export interface Provider {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** The key whose presence says the integration is configured. */
  key: string;
  /** Where the pill's ↗ goes (n8n opens its own instance; GitHub, the profile). */
  url?: string;
}

/** Declaration order is the pills' order, as at m3-ok. */
export const PROVIDERS: Provider[] = [
  { id: "integration_resend", name: "Resend", color: "#22C55E", key: "resend-api-key", url: "https://resend.com/emails",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38", key: "n8n-api-key",
    fields: [
      { key: "n8n-url", label: "URL da instância", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF", key: "vercel-token", url: "https://vercel.com/dashboard",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: GITHUB, name: "GitHub", color: "#F4505E", key: "github-token", url: "https://github.com", fields: [] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C", key: "notion-api-key", url: "https://notion.so",
    fields: [{ key: "notion-api-key", label: "Token de integração", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A", key: "calcom-api-key", url: "https://app.cal.com/bookings",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
  { id: "integration_stripe", name: "Stripe", color: "#0570DE", key: "stripe-api-key", url: "https://dashboard.stripe.com/payments",
    fields: [{ key: "stripe-api-key", label: "Chave secreta", placeholder: "sk_live_…", secret: true }] },
];

export const providerOf = (id: string) => PROVIDERS.find((p) => p.id === id);

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
  /** What just happened, for as long as the pill says it. */
  news?: IntegrationNews | null;
}

/** The settings fields this module owns; they travel in the flat settings.json (`extra` in Rust). */
export interface IntegrationSettings { activeIntegrations: string[]; githubMuted: string[] }
export const integrationSettings = (): IntegrationSettings => {
  const s = State.settings as unknown as Partial<IntegrationSettings>;
  s.activeIntegrations ??= [];
  s.githubMuted ??= [];
  return s as IntegrationSettings;
};

/** Pills the island may show next to Mochi (as at m3-ok). */
export const MAX_ACTIVE = 4;

export const info: Record<string, IntegrationInfo> = {};
/** The last words of a pill: [label, detail] of its news, for the n8n card. */
export const steps = new Map<string, string[]>();

/** Set by start(), cleared on stop: the views read the island through it. */
export const rt: { api: IslandApi | null } = { api: null };

export const redraw = () => {
  State.notify();
  rt.api?.island.redraw();
};

/** A timer owned by the module (cleared with it). A no-op once stopped. */
export function later(fn: () => void, ms: number): Disposer {
  return rt.api ? rt.api.timeout(fn, ms) : () => {};
}

/** Cleanups of what the views created lazily (observers); run when the module stops. */
export const cleanups = new Set<() => void>();

export function resetStore() {
  for (const k of Object.keys(info)) delete info[k];
  steps.clear();
}
