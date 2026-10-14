// Same ids, order, defaults and requirements as src-tauri/src/modules/mod.rs CATALOG.
import type { ModuleInfo } from "../core/moduleApi";

export const MODULE_INFO: ModuleInfo[] = [
  { id: "claude", label: "Claude Code", defaultEnabled: true },
  { id: "media", label: "Mídia", defaultEnabled: true },
  { id: "upload", label: "Soltar arquivo", defaultEnabled: true, requires: ["claude"] },
  { id: "timer", label: "Timer", defaultEnabled: false },
  { id: "voice", label: "Voz", defaultEnabled: false, requires: ["claude"] },
  { id: "github", label: "GitHub", defaultEnabled: false, group: "Integrações" },
  { id: "vercel", label: "Vercel", defaultEnabled: false, group: "Integrações" },
  { id: "stripe", label: "Stripe", defaultEnabled: false, group: "Integrações" },
  { id: "n8n", label: "n8n", defaultEnabled: false, group: "Integrações" },
  { id: "resend", label: "Resend", defaultEnabled: false, group: "Integrações" },
  { id: "calcom", label: "Cal.com", defaultEnabled: false, group: "Integrações" },
  { id: "notion", label: "Notion", defaultEnabled: false, group: "Integrações" },
];
