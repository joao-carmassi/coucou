// One-line sources (api.status.source): which of them reach the compact line. Pure, no timers, no DOM.
//  - the pinned one (setting `pinnedLine`, a single id) at BAND.PINNED, shown beside other pills;
//  - else the content of the module the user opened last, at the ambient band (above the other ambient lines).
// Everything stronger (notices, alerts, questions, any line above the pinned band) still wins in Compact.resolve.

import { BAND, type SourceDef, type StatusLine } from "./moduleApi.ts"; // .ts: node tests load this file

export const PIN_RELEASE_MS = 5 * 60_000;
export const LAST_OPENED_PRIORITY = BAND.AMBIENT + 2;

export interface Src { id: string; owner: string; def: SourceDef; line: StatusLine | null }

const own = (s: Src, priority: number, overGrid: boolean): StatusLine | null =>
  s.line && { ...s.line, ttlMs: undefined, still: true, priority, overGrid, view: s.line.view ?? s.def.view };

/** The two lines the sources contribute: the pinned one, and the last-opened module's first source with content. */
export function sourceLines(srcs: Iterable<Src>, pinned: string, lastOwner: string | null): { pin: StatusLine | null; last: StatusLine | null } {
  let pin: StatusLine | null = null, last: StatusLine | null = null;
  for (const s of srcs) {
    if (s.id === pinned) pin = own(s, BAND.PINNED, true);
    else if (!last && lastOwner !== null && s.owner === lastOwner) last = own(s, LAST_OPENED_PRIORITY, false);
  }
  return { pin, last };
}

/** The pinned id whose release timeout must run: it exists and has no content. */
export function releaseCandidate(srcs: Iterable<Src>, pinned: string): string | null {
  if (!pinned) return null;
  for (const s of srcs) if (s.id === pinned) return s.line ? null : s.id;
  return null;
}
