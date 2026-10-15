// Hub logic with no DOM: search, presets, import diff. The window (main.ts) only draws it.
import type { ModuleInfo } from "../core/moduleApi";

export interface HubSection { id: string; title: string; text: string }

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Ids of the sections containing every word of `q` in title or text (accents and case ignored). Empty query = all. */
export function matchSections(q: string, sections: readonly HubSection[]): string[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return sections
    .filter((s) => {
      const hay = fold(`${s.title} ${s.text}`);
      return words.every((w) => hay.includes(w));
    })
    .map((s) => s.id);
}

export const PRESETS: readonly { id: string; label: string }[] = [
  { id: "essencial", label: "Essencial" },
  { id: "dev", label: "Desenvolvedor" },
  { id: "tudo", label: "Tudo" },
  { id: "vitrine", label: "Vitrine" },
];

/** The module switches a preset sets: every catalog entry on if it lists the preset, off otherwise. */
export function presetModules(catalog: readonly ModuleInfo[], preset: string): Record<string, boolean> {
  return Object.fromEntries(catalog.map((m) => [m.id, m.presets?.includes(preset) === true]));
}

/** Same pattern as the Rust export filter. */
export const SECRET_KEY = /token|secret|password|api_?key|cookie/i;

/** Per-machine state: a backup from another PC must not carry it over. */
const MACHINE_KEYS = new Set(["hooksInstalled", "wslHooks", "claudeConfigDir", "onboardedVersion"]);

export type DiffKind = "novo" | "alterado";
export interface ImportDiff { patch: Record<string, unknown>; changes: { key: string; kind: DiffKind }[] }

/** Top-level diff of an imported file against the current settings. Secret-looking keys and `version` are never applied. */
export function diffImport(current: Record<string, unknown>, text: string): ImportDiff | string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "Arquivo inválido: não é JSON."; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Arquivo inválido: esperado um objeto.";
  const patch: Record<string, unknown> = {};
  const changes: ImportDiff["changes"] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === "version" || SECRET_KEY.test(k) || MACHINE_KEYS.has(k)) continue;
    if (JSON.stringify(current[k]) === JSON.stringify(v)) continue;
    patch[k] = v;
    changes.push({ key: k, kind: k in current ? "alterado" : "novo" });
  }
  return { patch, changes };
}
