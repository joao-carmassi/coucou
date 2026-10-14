// One entry per ported module. Order = start order (a requirement comes first); it must
// match the catalog order in modules/catalog.ts and src-tauri/src/modules/mod.rs.
import type { ModuleDef } from "../core/moduleApi";
import { claude } from "./claude";
import { media } from "./media";
import { uploadModule } from "./upload";
import { timerModule } from "./timer";
import { voiceModule } from "./voice";
import { github, vercel, stripe, n8n, resend, calcom, notion } from "./integrations/provider";

export const MODULES: ModuleDef[] = [claude, media, uploadModule, timerModule, voiceModule, github, vercel, stripe, n8n, resend, calcom, notion];
