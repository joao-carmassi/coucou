// What the integrations module knows while it runs. Module-level, reset on every start; the
// core never sees it (it gets pills, hooks and a view). The views reach the island through `rt`.

import type { Disposer, IslandApi } from "../../core/moduleApi";
import type { IntegrationNews } from "../../core/bridge";
import { State } from "../../core/state";

export { GITHUB, PROVIDERS, providerOf, type Provider } from "./providers";

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
export interface IntegrationSettings { githubMuted: string[] }
export const integrationSettings = (): IntegrationSettings => {
  const s = State.settings as unknown as Partial<IntegrationSettings>;
  s.githubMuted ??= [];
  return s as IntegrationSettings;
};

export const info: Record<string, IntegrationInfo> = {};
/** The last words of a pill: [label, detail] of its news, for the n8n card. */
export const steps = new Map<string, string[]>();

/** Set by the github module while it runs: the GitHub panel reads the island through it. */
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
