// The home's "primary": the pill whose card fills the left tile. A default one (setting `boardPrimary`: a
// module id, "claude" by default) and a short-lived user pick (a click on a pill in the list). The pick is
// judged on the next open, and also by ONE one-shot timeout armed only while a pick exists and the island is
// folded (cancelled on open or when the board stops): a folded island must not keep the picked pill in front.
// The timer is not trusted alone: `due` is also judged lazily on every visibility change (hover wake, open).

import type { Disposer, IslandApi, Pill } from "../../core/moduleApi";
import { App } from "../../kit/app";
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

  const log = (msg: string) => { void App.log(`board primary: ${msg}`); };
  const due = () => !!pick && closedAt !== null && Date.now() - closedAt >= settings().holdMs;

  /** Puts the default in front (never over a pill with news of its own). Focus services do nothing while the island is folded. */
  function applyDefault() {
    const want = defaultPill();
    const cur = front();
    if (!want || cur?.id === want.id || explicit(cur)) return;
    busy = true;
    try { put(want.id); } finally { busy = false; }
  }

  /** Ends a due pick on a folded island. `forced`: the timer itself (due by construction). The pick is kept when not due, so a later wake retries. */
  function revertPick(src: string, forced = false) {
    if (!pick) return;
    if (!forced && !due()) { log(`${src} pick-not-due`); return; }
    const cur = front();
    pick = null;
    if (explicit(cur)) { log(`${src} cur-explicit ${cur?.id}`); return; }
    applyDefault();
    log(`${src} applied, front=${front()?.id}`);
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
        revert = pick ? api.timeout(() => { revert = null; log("timer fired"); revertPick("timer", true); }, settings().holdMs) : null;
        return;
      }
      if (mode !== "expanded") { revertPick("wake"); return; } // hover wake: the timer may not have run
      if (prev === "expanded") return;
      revert?.();
      revert = null;
      if (due()) pick = null;
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
