// The home's "primary": the pill whose card fills the left tile. A default one (setting `boardPrimary`: a
// module id, "claude" by default) and a short-lived user pick (a click on a pill in the list). The pick is
// judged on the next open, and also by ONE one-shot timeout armed only while a pick exists and the island is
// folded (cancelled on open or when the board stops): a folded island must not keep the picked pill in front.

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
  let revert: Disposer | null = null;

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

  /** `folded`: nobody is looking, so nothing that could open the island runs (no pending request, no explicit default). */
  function applyDefault(folded = false) {
    const want = defaultPill();
    const cur = front();
    if (!want || cur?.id === want.id || explicit(cur)) return;
    if (folded && (explicit(want) || api.island.busy())) return;
    busy = true;
    try { put(want.id); } finally { busy = false; }
  }

  rt.choose = (id) => {
    put(id);
    pick = front()?.id === id ? id : null;
  };

  const offs = [
    api.onVisibility((mode, prev) => {
      if (prev === "expanded" && mode !== "expanded") {
        closedAt = Date.now();
        revert?.();
        revert = pick ? api.timeout(() => { revert = null; if (!pick) return; pick = null; applyDefault(true); }, settings().holdMs) : null;
      }
      if (mode !== "expanded" || prev === "expanded") return;
      revert?.();
      revert = null;
      if (pick && closedAt !== null && Date.now() - closedAt >= settings().holdMs) pick = null;
      closedAt = null;
      if (!pick) applyDefault();
    }),
    // Anything else that takes the front (news, an error, a disabled provider) ends the pick.
    api.island.onChange(() => {
      if (busy || !pick || front()?.id === pick) return;
      const gone = !api.pills.get(pick);
      pick = null;
      revert?.();
      revert = null;
      if (gone) applyDefault();
    }),
  ];
  return () => { revert?.(); rt.choose = null; offs.reverse().forEach((o) => o()); };
}
