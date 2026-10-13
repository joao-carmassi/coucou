// M5 adds one entry per ported module. Order = start order (a requirement comes first).
import type { ModuleDef } from "../core/moduleApi";
import { claude } from "./claude";
import { media } from "./media";
import { timerModule } from "./timer";

export const MODULES: ModuleDef[] = [claude, media, timerModule];
