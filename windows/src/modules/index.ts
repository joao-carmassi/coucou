// M5 adds one entry per ported module. Order = start order (a requirement comes first).
import type { ModuleDef } from "../core/moduleApi";
import { claude } from "./claude";
import { timerModule } from "./timer";
import { uploadModule } from "./upload";

export const MODULES: ModuleDef[] = [claude, timerModule, uploadModule];
