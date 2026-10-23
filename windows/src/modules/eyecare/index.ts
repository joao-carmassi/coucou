// Pausas: break reminders (one scoped api.timeout, no polling; a card asks for confirmation) + a view with breaks and screen time per app.
// Screen time is counted in Rust from the shared foreground hook; this side only asks for numbers.
import "./eyecare.css";
import { svg } from "../../kit/dom";
import { ICONS } from "../../kit/icons";
import { PANEL_H, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { EyecareBridge } from "./bridge";
import { ASK_MS, BREAKS, RETRY_MS, enabledKinds, intervalMin, pickKind, roundOf, type BreakKind } from "./logic";
import { buildAsk } from "./ask";
import { buildView } from "./view";

const VIEW = "eyecare-break";

interface Cfg { eyecareInterval: unknown; eyecareKinds: unknown }

/** The reminder waiting for an answer (one at a time); the card view reads it. */
let asking: { kind: BreakKind; answer(taken: boolean): void } | null = null;

function start(api: IslandApi): Disposer {
  let timer: Disposer | null = null;
  let n = 0;
  let alive = true;
  let checking = false; // a checkpoint is in flight: fire() re-arms by itself
  let dropAsk: Disposer | null = null; // closes the card request and its expiry
  const closeAsk = () => {
    dropAsk?.();
    dropAsk = null;
    asking = null;
    // No other request took the screen: fold, or the island stays open on a spent card (the mouse is on it after a click).
    if (api.island.mode() === "expanded" && api.island.view() === VIEW) api.island.close();
    api.island.redraw();
  };
  // Reads the settings each time, so a change applies from the next wait on. `ms` overrides the interval (retry).
  const arm = (ms = 0) => {
    timer?.();
    timer = null;
    const min = intervalMin(api.settings<Cfg>().eyecareInterval);
    if (alive && min) timer = api.timeout(() => void fire(), ms || min * 60_000);
  };
  const ask = (kind: BreakKind) => {
    const offReq = api.island.request({ view: VIEW, priority: 50, pin: true });
    const answer = (taken: boolean) => { if (asking?.kind !== kind) return; void EyecareBridge.mark(taken); closeAsk(); };
    const offTimer = api.timeout(() => answer(false), ASK_MS);
    asking = { kind, answer };
    dropAsk = () => { offReq(); offTimer(); };
    api.island.redraw();
  };
  const fire = async () => {
    timer = null;
    checking = true;
    // The checkpoint also cuts the screen-time segment, so a long away stretch is not counted.
    const cp = await EyecareBridge.checkpoint();
    checking = false;
    if (!alive) return;
    const min = intervalMin(api.settings<Cfg>().eyecareInterval);
    if (!min) { arm(); return; } // switched off while waiting
    const kind = pickKind(enabledKinds(api.settings<Cfg>().eyecareKinds), n);
    if (!kind || api.paused() || asking) { arm(); return; }
    const round = roundOf(cp?.idle ?? null, cp?.quiet ?? false, min * 60_000);
    if (round === "wait") { arm(RETRY_MS); return; } // not counted, same kind next time
    if (round === "taken") void EyecareBridge.mark(true);
    if (round === "ask") {
      n++;
      // Before the request: busy() is true while our own card is up.
      if (!api.island.busy()) api.avatar.emote(BREAKS[kind].emote);
      ask(kind);
    }
    arm();
  };
  arm();
  // Re-arm on a settings change (deferred: the stored settings are replaced by a listener that runs after ours).
  const off = api.listen("settings-changed", () => void api.timeout(() => { if (alive && !checking) arm(); }, 0));
  // Pause or stop: nobody can answer; the round is neither taken nor missed.
  const offPause = api.onPause((p) => { if (p && asking) closeAsk(); });
  return () => { alive = false; timer?.(); off(); offPause(); if (asking) closeAsk(); };
}

export const eyecareModule: ModuleDef = {
  id: "eyecare",
  views: [
    { name: "eyecare", layout: { height: PANEL_H, botX: 54, botY: null, botDiameter: 46 }, build: (ctx) => buildView(ctx) },
    // botX 54 / 46: the placement every module view uses, clear of the 84 px the card's text leaves to Mochi.
    { name: VIEW, layout: { height: 160, botX: 54, botY: null, botDiameter: 46 }, build: () => buildAsk({ get kind() { return asking?.kind ?? null; }, answer: (t) => asking?.answer(t) }) },
  ],
  tabs: [{ view: "eyecare", title: "Pausas", icon: () => svg(ICONS.eye, 13, { stroke: 2 }), order: 100 }],
  start,
};
