// The registry of one-line sources and the pinned line (api.status.source / pin). The pin lives in the flat setting `pinnedLine`.
// Zero idle: the only timeout is ONE, armed while the pinned source has no content and cancelled when it has some again.

import { Bridge } from "./bridge";
import { Compact } from "./compact";
import type { SourceDef, StatusLine } from "./moduleApi";
import { PIN_RELEASE_MS, releaseCandidate, sourceLines, type Src } from "./sources";
import { State } from "./state";

const sources = new Map<string, Src>();
let lastOwner: string | null = null;
let lastT: number | null = null;
let releaseAt: { id: string; t: number } | null = null;

const pinned = () => (typeof State.settings.pinnedLine === "string" ? State.settings.pinnedLine : "");

function release(id: string) {
  releaseAt = null;
  if (pinned() === id && releaseCandidate(sources.values(), id) === id) Pin.set("");
}

export const Pin = {
  pinned,

  add(owner: string, key: string, def: SourceDef): Src {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`module ${owner}: source key "${key}" must match [a-z0-9-]+`);
    const s: Src = { id: `${owner}.${key}`, owner, def, line: null };
    sources.set(s.id, s);
    Pin.sync();
    return s;
  },

  /** True when it was registered (the line on screen may have changed). */
  remove(s: Src): boolean {
    if (sources.get(s.id) !== s) return false;
    sources.delete(s.id);
    return Pin.sync() || true;
  },

  /** True when the compact line changed: the caller redraws. */
  setLine(s: Src, line: StatusLine | null): boolean {
    if (sources.get(s.id) !== s) return false;
    s.line = line;
    return Pin.sync();
  },

  /** The last module the user opened (null: the island hid), kept for `ms` (the focus time). True when the compact line changed. */
  setLast(owner: string | null, ms = 0): boolean {
    if (lastT) window.clearTimeout(lastT);
    lastT = null;
    if (owner !== null && ms > 0) lastT = window.setTimeout(() => { lastT = null; if (Pin.setLast(null)) State.notify(); }, ms);
    if (owner === lastOwner) return false;
    lastOwner = owner;
    return Pin.sync();
  },

  /** Pins `id` ("" releases) and saves it. Notifies State: the pin buttons and the line follow. */
  set(id: string) {
    if (pinned() === id) return;
    State.settings.pinnedLine = id;
    void Bridge.saveSettings({ pinnedLine: id });
    Pin.sync();
    State.notify();
  },

  list: (): readonly Src[] => [...sources.values()],

  /** Recomputes the lines in Compact and the release timeout. True when a line changed. */
  sync(): boolean {
    const p = pinned();
    const { pin, last } = sourceLines(sources.values(), p, lastOwner);
    const a = Compact.set("#pin", pin), b = Compact.set("#last", last);
    const changed = a || b;
    const want = releaseCandidate(sources.values(), p);
    if (releaseAt && releaseAt.id !== want) { window.clearTimeout(releaseAt.t); releaseAt = null; }
    if (want && !releaseAt) releaseAt = { id: want, t: window.setTimeout(() => release(want), PIN_RELEASE_MS) };
    return changed;
  },

  /** Test helper: forgets everything. */
  reset() {
    if (releaseAt) window.clearTimeout(releaseAt.t);
    releaseAt = null;
    sources.clear();
    if (lastT) window.clearTimeout(lastT);
    lastT = null;
    lastOwner = null;
    Compact.set("#pin", null);
    Compact.set("#last", null);
  },
};
