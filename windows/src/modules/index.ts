// Every module is found here: a folder with an index.ts exporting ModuleDef(s) and a manifest.json.
// Start order comes from the manifests (catalog.ts), not from this list. Import order = CSS order
// (alphabetical by folder): module sheets must not depend on each other (see docs/MODULES-CONTRACT.md).
import type { ModuleDef } from "../core/moduleApi";
import { collectDefs } from "./resolve";

export const MODULES: ModuleDef[] = collectDefs<ModuleDef>(Object.values(import.meta.glob<Record<string, unknown>>("./*/index.ts", { eager: true })));
