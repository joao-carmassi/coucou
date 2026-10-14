// The catalog: derived from modules/<folder>/manifest.json (Rust builds the same one in build.rs).
// Loads only the manifests, so the settings window can use it without any module code.
import { buildCatalog, type Manifest } from "./resolve";

export const MODULE_INFO = buildCatalog(Object.values(import.meta.glob<Manifest | Manifest[]>("./*/manifest.json", { eager: true, import: "default" })), import.meta.env.DEV);
