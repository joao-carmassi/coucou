// What the settings window loads of the modules: the sections only. It must not import a module's
// index.ts (that would drag the island's code and CSS into the settings window). Keys are module ids.
import { claudeSettingsSection } from "./claude/settings";
import { PROVIDERS, moduleIdOf } from "./integrations/providers";
import { providerSettingsSection } from "./integrations/settings";
import { voiceSettingsSection } from "./voice/settings";

export type SettingsSection = () => { el: HTMLElement; dispose?(): void };

export const SETTINGS_SECTIONS: Record<string, SettingsSection> = {
  claude: claudeSettingsSection,
  voice: voiceSettingsSection,
  ...Object.fromEntries(PROVIDERS.map((p) => [moduleIdOf(p), () => providerSettingsSection(p)])),
};
