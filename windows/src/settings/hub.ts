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

/** Labels of the preset ids every install knows; any other id a manifest lists gets its capitalised id. Order here = order on screen. */
const PRESET_LABELS: Record<string, string> = { essencial: "Essencial", dev: "Desenvolvedor", tudo: "Tudo" };

/** The presets the manifests offer: the known ones first, the rest in the order they appear. */
export function presetsOf(catalog: readonly ModuleInfo[]): { id: string; label: string }[] {
  const ids = [...new Set(catalog.flatMap((m) => m.presets ?? []))];
  const rank = (id: string) => { const i = Object.keys(PRESET_LABELS).indexOf(id); return i < 0 ? Infinity : i; };
  return ids.sort((a, b) => rank(a) - rank(b)).map((id) => ({ id, label: PRESET_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1) }));
}

/** The module switches a preset sets: every catalog entry on if it lists the preset, off otherwise. */
export function presetModules(catalog: readonly ModuleInfo[], preset: string): Record<string, boolean> {
  return Object.fromEntries(catalog.map((m) => [m.id, m.presets?.includes(preset) === true]));
}

/** Same pattern as the Rust export filter. */
export const SECRET_KEY = /token|secret|password|api_?key|cookie/i;

/** Per-machine state: a backup from another PC must not carry it over. Core's own key plus what the manifests declare (`machineKeys`). */
const machineKeys = (catalog: readonly ModuleInfo[]) => new Set(["onboardedVersion", ...catalog.flatMap((m) => m.machineKeys ?? [])]);

/** A copy of `v` without secret-looking keys at any depth (the Rust export filter, applied to what comes in). */
export function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, stripSecrets(x)]));
  return v;
}

export type DiffKind = "novo" | "alterado";
export interface ImportDiff { patch: Record<string, unknown>; changes: { key: string; kind: DiffKind }[] }

/** Top-level diff of an imported file against the current settings. Secret-looking keys and `version` are never applied. */
export function diffImport(current: Record<string, unknown>, text: string, catalog: readonly ModuleInfo[]): ImportDiff | string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return "Arquivo inválido: não é JSON."; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Arquivo inválido: esperado um objeto.";
  const patch: Record<string, unknown> = {};
  const changes: ImportDiff["changes"] = [];
  const machine = machineKeys(catalog);
  for (const [k, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === "version" || SECRET_KEY.test(k) || machine.has(k)) continue;
    const v = stripSecrets(raw);
    if (JSON.stringify(current[k]) === JSON.stringify(v)) continue;
    patch[k] = v;
    changes.push({ key: k, kind: k in current ? "alterado" : "novo" });
  }
  return { patch, changes };
}
