// The provider table: pure data and helpers (no DOM, no State), so Node tests can load it.

export const GITHUB = "integration_github";

export interface Provider {
  /** The pill / task id (`integration_<short>`); the module id is the short part. */
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

/** Catalog order (modules/catalog.ts): it is also the pills' order. */
export const PROVIDERS: Provider[] = [
  { id: GITHUB, name: "GitHub", color: "#F4505E", key: "github-token", url: "https://github.com", fields: [] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF", key: "vercel-token", url: "https://vercel.com/dashboard",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_stripe", name: "Stripe", color: "#0570DE", key: "stripe-api-key", url: "https://dashboard.stripe.com/payments",
    fields: [{ key: "stripe-api-key", label: "Chave secreta", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38", key: "n8n-api-key",
    fields: [
      { key: "n8n-url", label: "URL da instância", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E", key: "resend-api-key", url: "https://resend.com/emails",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A", key: "calcom-api-key", url: "https://app.cal.com/bookings",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C", key: "notion-api-key", url: "https://notion.so",
    fields: [{ key: "notion-api-key", label: "Token de integração", placeholder: "ntn_…", secret: true }] },
];

export const providerOf = (id: string) => PROVIDERS.find((p) => p.id === id);
/** The module id of a provider: `integration_n8n` → `n8n`. */
export const moduleIdOf = (p: Provider) => p.id.slice("integration_".length);
/** A pill exists while its module is on AND its key is stored. */
export const pillPresent = (enabled: boolean, keyPresent: boolean) => enabled && keyPresent;
