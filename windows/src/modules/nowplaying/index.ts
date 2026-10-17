// Tocando agora: the player (Rust: Windows media session) as a tab, a one-line source "track" (the compact card: cover, title,
// artist, time left; shown when pinned from the tab or right after leaving it) and a peek when the track changes; the spectrum (Rust: loopback + FFT) makes the one Mochi dance and fills the bars, and runs
// only while someone sees it.
import "./nowplaying.css";
import { svg } from "../../kit/dom";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { NowPlayingBridge as Bridge } from "./bridge";
import { ICONS } from "./icons";
import { compactCard, danceLevel, trackKey, trackLine, wantCapture, wantTick, clampSens, type Cfg, type Track } from "./logic";
import { NP } from "./store";
import { buildView } from "./view";

function start(api: IslandApi): Disposer {
  NP.reset();
  const cfg = () => api.settings<Cfg>();
  let capturing = false;
  let tick: Disposer | null = null;
  let announced = trackKey(null);
  // The card shows for the focus time after the tab is left (until the island hides): the 1 s tick is for that, or for the pin.
  let recent = false;
  let wasOnTab = false;
  let recentT: Disposer | null = null;
  const source = api.status.source("track", { label: "Tocando agora", view: "nowplaying" });

  // One place decides what runs: the capture and the 1 s progress tick exist only while they have a viewer.
  const reconcile = () => {
    const mode = api.island.mode(), view = api.island.view();
    const onTab = mode === "expanded" && view === "nowplaying";
    if (mode === "hidden") { recent = false; recentT?.(); recentT = null; }
    else if (recent && mode === "expanded" && !onTab) { recent = false; recentT?.(); recentT = null; } // another module's view took over
    else if (wasOnTab && !onTab && mode !== "expanded") {
      recent = true;
      recentT?.();
      recentT = api.timeout(() => { recent = false; recentT = null; reconcile(); }, api.island.focusMs());
    }
    wasOnTab = onTab;
    const c = cfg();
    NP.sens = clampSens(c.nowplayingSensitivity);
    const capture = wantCapture({ playing: !!NP.track?.playing, paused: api.paused(), mode, view, dance: c.nowplayingDance !== false });
    if (capture !== capturing) {
      capturing = capture;
      void Bridge.capture(capture).catch((e) => api.island.error(e));
      if (!capture) { NP.bands = []; api.avatar.level(0); NP.paintBars?.(); }
    }
    const progress = wantTick({ playing: !!NP.track?.playing, paused: api.paused(), mode, view, cardShown: api.status.pinned("track") || recent, hasLength: !!NP.track?.durationMs && NP.track.positionMs !== null });
    if (progress && !tick) tick = api.interval(() => { NP.paintProgress?.(); publishCard(); }, 1000, { whenVisible: true });
    else if (!progress && tick) { tick(); tick = null; }
    publishCard();
  };

  // The card (cover, title, artist, time left; dimmed while paused) whenever a track is known: the core decides when it is shown.
  const publishCard = () => {
    const t = NP.track;
    source.set(t && !api.paused() ? { priority: BAND.AMBIENT, ...compactCard(t, Date.now()) } : null);
  };

  const apply = (t: Track | null, initial = false) => {
    const was = NP.track;
    NP.track = t;
    // A new track peeks at the island (not when it is already open on the player, nor on the first read).
    const key = trackKey(t);
    if (!initial && t?.playing && key !== announced && key !== trackKey(was) && api.island.mode() !== "expanded") {
      api.island.notice({ text: trackLine(t), priority: BAND.ACTIVE + 10, ms: 3500, key: "track", view: "nowplaying", peek: true });
    }
    if (t?.playing) announced = key;
    reconcile();
    ctxRepaint();
  };
  const ctxRepaint = () => { api.island.redraw(); NP.paintProgress?.(); };

  const offs: Disposer[] = [
    api.listen<Track | null>("nowplaying-state", (t) => apply(t)),
    api.listen<{ bands: number[]; level: number }>("nowplaying-bands", (p) => {
      if (!capturing) return; // a late event after the capture was switched off
      NP.bands = p.bands;
      NP.paintBars?.();
      if (cfg().nowplayingDance !== false) api.avatar.level(danceLevel(p.level, NP.sens), { dance: true });
    }),
    // The settings window saved: the core updates State after its own listener, so look one tick later.
    api.listen("settings-changed", () => { api.timeout(reconcile, 0); }),
    api.island.onChange(reconcile),
    api.onVisibility(reconcile),
    api.onPause(reconcile),
    api.actions.add({
      id: "toggle", title: "Tocar ou pausar a música", keywords: ["música", "play", "pausa", "spotify", "tocando"], key: "p",
      when: () => !!NP.track?.canToggle, run: () => Bridge.control("toggle"),
    }),
    api.actions.add({
      id: "next", title: "Próxima faixa", keywords: ["música", "pular", "next", "spotify", "tocando"], key: "n",
      when: () => !!NP.track?.canNext, run: () => Bridge.control("next"),
    }),
  ];
  // What was already playing when the module was switched on.
  void Bridge.state().then((t) => { if (t) apply(t, true); }).catch(() => {});
  reconcile();

  return () => {
    for (const off of offs.reverse()) off();
    tick?.();
    tick = null;
    if (capturing) void Bridge.capture(false).catch(() => {});
    capturing = false;
    api.avatar.level(0);
    source.dispose();
    NP.paintProgress = NP.paintBars = null;
    NP.reset();
  };
}

export const nowplayingModule: ModuleDef = {
  id: "nowplaying",
  views: [{
    name: "nowplaying",
    layout: { height: 200, botX: 54, botY: null, botDiameter: 46, botCenter: { top: 42, h: 158 } },
    build: (ctx) => buildView(ctx),
  }],
  tabs: [{ view: "nowplaying", title: "Tocando", icon: () => svg(ICONS.note, 13), order: 35 }],
  start,
};
