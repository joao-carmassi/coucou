// Tocando agora: the player (Rust: Windows media session) as a tab, an ambient pill and a peek when the track changes;
// the spectrum (Rust: loopback + FFT) drives Mochi's squash and the bars, and runs only while someone sees it.
import "./nowplaying.css";
import { svg } from "../../kit/dom";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { NowPlayingBridge as Bridge } from "./bridge";
import { ICONS } from "./icons";
import { danceLevel, trackKey, trackLine, wantCapture, clampSens, type Cfg, type Track } from "./logic";
import { NP } from "./store";
import { buildView } from "./view";

const PILL = "nowplaying";

function start(api: IslandApi): Disposer {
  NP.reset();
  const cfg = () => api.settings<Cfg>();
  let capturing = false;
  let tick: Disposer | null = null;
  let announced = trackKey(null);

  // One place decides what runs: the capture and the 1 s progress tick exist only while they have a viewer.
  const reconcile = () => {
    const mode = api.island.mode(), view = api.island.view();
    const c = cfg();
    NP.sens = clampSens(c.nowplayingSensitivity);
    const capture = wantCapture({ playing: !!NP.track?.playing, paused: api.paused(), mode, view, dance: c.nowplayingDance !== false });
    if (capture !== capturing) {
      capturing = capture;
      void Bridge.capture(capture).catch((e) => api.island.error(e));
      if (!capture) { NP.bands = []; api.avatar.level(0); NP.paintBars?.(); }
    }
    const progress = !!NP.track?.playing && mode === "expanded" && view === "nowplaying";
    if (progress && !tick) tick = api.interval(() => NP.paintProgress?.(), 1000, { whenVisible: true });
    else if (!progress && tick) { tick(); tick = null; }
  };

  const apply = (t: Track | null, initial = false) => {
    const was = NP.track;
    NP.track = t;
    if (t?.playing) {
      api.pills.set({ id: PILL, label: t.title || t.app, color: "#b79cff", mood: "idle", ambient: true });
    } else api.pills.remove(PILL);
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
      if (cfg().nowplayingDance !== false) api.avatar.level(danceLevel(p.level, NP.sens));
    }),
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
    api.pills.remove(PILL);
    NP.paintProgress = NP.paintBars = null;
    NP.reset();
  };
}

export const nowplayingModule: ModuleDef = {
  id: "nowplaying",
  views: [{
    name: "nowplaying",
    layout: { height: 175, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildView(ctx),
  }],
  tabs: [{ view: "nowplaying", title: "Tocando", icon: () => svg(ICONS.note, 13), order: 35 }],
  start,
};
