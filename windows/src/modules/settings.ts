// What the settings window loads of the modules: the sections only. It must not import a module's
// index.ts (that would drag the island's code and CSS into the settings window). Each folder's
// settings.ts exports `settingsSections: Record<moduleId, SettingsSection>`.
import type { SettingsSection } from "../core/moduleApi";

export type { SettingsSection };

export const SETTINGS_SECTIONS: Record<string, SettingsSection> = Object.assign(
  {},
  ...Object.values(import.meta.glob<{ settingsSections?: Record<string, SettingsSection> }>("./*/settings.ts", { eager: true })).map((m) => m.settingsSections),
);
