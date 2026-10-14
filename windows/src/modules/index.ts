// One entry per ported module. Order = start order (a requirement comes first); it must
// match the catalog order in modules/catalog.ts and src-tauri/src/modules/mod.rs.
import type { ModuleDef } from "../core/moduleApi";
// Import order = CSS order (each module imports its own sheets): claude, upload, integrations,
// media, timer. It is the order the sheets had in style/index.ts; it differs from the catalog on purpose.
import { claude } from "./claude";
import { uploadModule } from "./upload";
import { github, vercel, stripe, n8n, resend, calcom, notion } from "./integrations/provider";
import { media } from "./media";
import { timerModule } from "./timer";
import { voiceModule } from "./voice";

export const MODULES: ModuleDef[] = [claude, media, uploadModule, timerModule, voiceModule, github, vercel, stripe, n8n, resend, calcom, notion];
