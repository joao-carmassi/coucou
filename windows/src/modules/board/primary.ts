// The home's "primary": the pill whose card fills the left tile. A default one (setting `boardPrimary`: a
// module id, "claude" by default) and a short-lived user pick (a click on a pill in the list). No timers:
// the close time is stamped on visibility and the pick is judged lazily on the next open.

import type { Disposer, IslandApi, Pill } from "../../core/moduleApi";
import type { BoardFocus } from "./api";

export interface PrimarySettings { boardPrimary: string; focusHoldMinutes: number }

/** Moods that carry something to read: the user's default never takes the tile from these. */
const EXPLICIT = new Set(["alert", "ask", "error", "done"]);

/** Set while the board runs: the view clicks through it. */
export const rt: { choose: ((id: string) => void) | null } = { choose: null };

export function startPrimary(api: IslandApi): Disposer {
  let pick: string | null = null;
  let closedAt: number | null = null;
  let busy = false;

  const settings = () => {
    const s = api.settings<PrimarySettings>();
    const hold = Number(s.focusHoldMinutes);
    return { primary: typeof s.boardPrimary === "string" && s.boardPrimary ? s.boardPrimary : "", holdMs: (Number.isFinite(hold) ? hold : 1) * 60_000 };
  };
  const front = () => api.pills.front();
  const put = (id: string) => { for (const f of api.useAll<BoardFocus>("board.focus")) { try { f(id); } catch (err) { console.error("[coucou] pill service failed", err); } } };

  /** The default's pill: the first one its module owns. Missing = the existing fallback chain stays. */
  const defaultPill = (): Pill | undefined => api.pills.all().find((p) => p.owner === settings().primary);
  const explicit = (p: Pill | null) => !!p && (EXPLICIT.has(p.mood) || !!p.badge);

  function applyDefault() {
    const want = defaultPill();
    const cur = front();
    if (!want || cur?.id === want.id || explicit(cur)) return;
    busy = true;
    try { put(want.id); } finally { busy = false; }
  }

  rt.choose = (id) => {
    put(id);
    pick = front()?.id === id ? id : null;
  };

  const offs = [
    api.onVisibility((mode, prev) => {
      if (prev === "expanded" && mode !== "expanded") closedAt = Date.now();
      if (mode !== "expanded" || prev === "expanded") return;
      if (pick && closedAt !== null && Date.now() - closedAt >= settings().holdMs) pick = null;
      closedAt = null;
      if (!pick) applyDefault();
    }),
    // Anything else that takes the front (news, an error, a disabled provider) ends the pick.
    api.island.onChange(() => {
      if (busy || !pick || front()?.id === pick) return;
      const gone = !api.pills.get(pick);
      pick = null;
      if (gone) applyDefault();
    }),
  ];
  return () => { rt.choose = null; offs.reverse().forEach((o) => o()); };
}
