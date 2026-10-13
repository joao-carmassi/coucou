// M5 adds one entry per ported module.
import type { ModuleDef } from "../core/moduleApi";
import { claude } from "./claude";

export const MODULES: ModuleDef[] = [claude];
