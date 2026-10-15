// Pure catalog logic (no import.meta.glob), so node tests can feed it explicit manifests.
import type { ModuleInfo } from "../core/moduleApi";

/** modules/<folder>/manifest.json: one object, or an array when a folder holds several modules. */
export interface Manifest {
  id: string;
  label: string;
  default: boolean;
  requires?: string[];
  group?: string;
  /** Start order and settings order; a requirement must come before its dependents. */
  order: number;
  /** The module's keys in settings.json with their defaults; new modules prefix them with their id. */
  settingsDefaults?: Record<string, unknown>;
  /** Only in debug builds (dev); release catalogs leave it out. */
  devOnly?: boolean;
  /** Preset ids (essencial, dev, tudo, vitrine) that switch this module on. */
  presets?: string[];
  /** Stays on in safe mode (read by Rust build.rs). */
  essential?: boolean;
}

export function buildCatalog(files: readonly (Manifest | readonly Manifest[])[], dev: boolean): ModuleInfo[] {
  return files
    .flat()
    .filter((m) => dev || !m.devOnly)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => ({ id: m.id, label: m.label, defaultEnabled: m.default, requires: m.requires, group: m.group, settingsDefaults: m.settingsDefaults, presets: m.presets }));
}

/** Every exported value that looks like a ModuleDef, from the modules' index.ts namespaces. */
export function collectDefs<T extends { id: string; start: unknown }>(namespaces: readonly Record<string, unknown>[]): T[] {
  return namespaces.flatMap((ns) => Object.values(ns)).filter((v): v is T => !!v && typeof v === "object" && "id" in v && typeof (v as { start?: unknown }).start === "function");
}
