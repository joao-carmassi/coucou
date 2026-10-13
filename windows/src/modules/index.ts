// M5 adds one entry per ported module.
import type { ModuleDef } from "../core/moduleApi";
import { timerModule } from "./timer";

export const MODULES: ModuleDef[] = [timerModule];
