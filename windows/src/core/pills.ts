// Pill list helpers: pure, so they test under node (type imports only). A pill belongs to the module that put it there.
// Old mood / badge names are mapped by the caller (the registry), not here.

import type { Pill, PillAt, PillPatch } from "./state";

export interface PillStore { pills: Pill[]; focusId: string | null }

/**
 * Creates a pill (needs label and color) or patches the one this owner already has.
 * Another module's pill is never touched. True when something changed.
 */
export function putPill(s: PillStore, owner: string, p: PillPatch, at?: PillAt): boolean {
  const patch = p;
  const cur = s.pills.find((x) => x.id === p.id);
  if (cur) {
    if (cur.owner !== owner) return false;
    let changed = false;
    for (const k of ["label", "color", "mood", "emote", "eye", "badge", "ambient"] as const) {
      if (patch[k] !== undefined && cur[k] !== patch[k]) { Object.assign(cur, { [k]: patch[k] }); changed = true; }
    }
    return changed;
  }
  if (patch.label === undefined || patch.color === undefined) return false;
  // The first pill ever put in front; from then on only api.pills.focus and removal move it.
  if (!s.focusId) s.focusId = p.id;
  s.pills.splice(pillIndex(s.pills, at), 0, { id: p.id, label: patch.label, color: patch.color, mood: patch.mood ?? "idle", emote: patch.emote, eye: patch.eye, badge: patch.badge, ambient: patch.ambient, owner });
  return true;
}

/** Removes one pill of `owner` (or all of its pills); focus moves off a removed pill. True when any went. */
export function dropPills(s: PillStore, owner: string, id?: string): boolean {
  const gone = s.pills.filter((x) => x.owner === owner && (id === undefined || x.id === id)).map((x) => x.id);
  if (!gone.length) return false;
  s.pills = s.pills.filter((x) => !gone.includes(x.id));
  if (s.focusId && gone.includes(s.focusId)) s.focusId = s.pills[0]?.id ?? null;
  return true;
}

/**
 * Puts `owner`'s pill in front. `opening`: the pill whose pillOpen reaction is running, which any module may focus.
 * A pill that is missing or another module's is refused. True when the front changed.
 */
export function focusPill(s: PillStore, owner: string, id: string, opening?: string | null): boolean {
  const p = s.pills.find((x) => x.id === id);
  if (!p || (p.owner !== owner && id !== opening) || s.focusId === id) return false;
  s.focusId = id;
  return true;
}

/** append (default) | "start" | after: a missing anchor means the start | before: a missing anchor means the end. */
function pillIndex(pills: Pill[], at?: PillAt): number {
  if (at === "start") return 0;
  if (!at) return pills.length;
  if ("after" in at) return pills.findIndex((x) => x.id === at.after) + 1;
  const i = pills.findIndex((x) => x.id === at.before);
  return i < 0 ? pills.length : i;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Body colour for a pill: exact id > longest "prefix*" > `own`. Entries that are not #rrggbb are ignored. */
export function colorFor(map: Readonly<Record<string, string>> | undefined, id: string, own: string): string {
  if (!map) return own;
  if (HEX.test(map[id] ?? "")) return map[id];
  let best = "";
  let hit = "";
  for (const [k, v] of Object.entries(map)) {
    if (k.length > 1 && k.endsWith("*") && id.startsWith(k.slice(0, -1)) && k.length > best.length && HEX.test(v)) { best = k; hit = v; }
  }
  return hit || own;
}
