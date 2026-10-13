// Same ids, order, defaults and requirements as src-tauri/src/modules/mod.rs CATALOG.
import type { ModuleInfo } from "../core/moduleApi";

export const MODULE_INFO: ModuleInfo[] = [
  { id: "claude", label: "Claude Code", defaultEnabled: true },
  { id: "media", label: "Mídia", defaultEnabled: true },
  { id: "upload", label: "Soltar arquivo", defaultEnabled: true, requires: ["claude"] },
  { id: "timer", label: "Timer", defaultEnabled: false },
  { id: "voice", label: "Voz", defaultEnabled: false, requires: ["claude"] },
  { id: "integrations", label: "Integrações", defaultEnabled: false },
];
