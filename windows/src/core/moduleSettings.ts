// A module's slice of the flat settings.json: typed snapshot + partial save. Shared by the island (api.settings /
// api.saveSettings) and the settings window (SettingsSection argument). Only the keys the manifest declares.

import { Bridge } from "./bridge";
import { State } from "./state";

export interface ModuleSettings {
  get<T extends object = Record<string, unknown>>(): Readonly<T>;
  save(patch: Record<string, unknown>): Promise<void>;
}

/** Core-owned keys a module may read (declared in its manifest) but never write. */
const CORE_KEYS = new Set(["focusHoldMinutes", "modulesEnabled"]);

export function moduleSettings(id: string, defaults: Readonly<Record<string, unknown>> = {}): ModuleSettings {
  return {
    get<T extends object>() {
      const stored = State.settings as unknown as Record<string, unknown>; // main.ts / the settings window replace the object
      const snap: Record<string, unknown> = {};
      for (const k of Object.keys(defaults)) snap[k] = structuredClone(k in stored && stored[k] !== undefined ? stored[k] : defaults[k]);
      return Object.freeze(snap) as Readonly<T>;
    },
    async save(patch) {
      const bad = Object.keys(patch).filter((k) => !(k in defaults));
      if (bad.length) throw new Error(`module ${id}: settings key(s) not declared in its manifest: ${bad.join(", ")}`);
      const core = Object.keys(patch).filter((k) => CORE_KEYS.has(k));
      if (core.length) throw new Error(`module ${id}: core settings key(s) are read-only: ${core.join(", ")}`);
      Object.assign(State.settings, patch);
      return Bridge.saveSettings(patch).then(() => undefined);
    },
  };
}
