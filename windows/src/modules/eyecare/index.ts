// Pausas: break reminders (one scoped api.timeout, no polling) + a view with screen time per app.
// Screen time is counted in Rust from the shared foreground hook; this side only asks for numbers.
import "./eyecare.css";
import { svg } from "../../kit/dom";
import { ICONS } from "../../kit/icons";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { EyecareBridge } from "./bridge";
import { BREAKS, enabledKinds, intervalMin, pickKind, shouldNotify } from "./logic";
import { buildView } from "./view";

interface Cfg { eyecareInterval: unknown; eyecareKinds: unknown }

function start(api: IslandApi): Disposer {
  let timer: Disposer | null = null;
  let n = 0;
  let alive = true;
  // Reads the settings each time, so a change applies from the next wait on.
  const arm = () => {
    timer?.();
    timer = null;
    const min = intervalMin(api.settings<Cfg>().eyecareInterval);
    if (alive && min) timer = api.timeout(() => void fire(), min * 60_000);
  };
  const fire = async () => {
    timer = null;
    // The checkpoint also cuts the screen-time segment, so a long away stretch is not counted.
    const idle = await EyecareBridge.checkpoint();
    if (!alive) return;
    const kind = pickKind(enabledKinds(api.settings<Cfg>().eyecareKinds), n);
    if (kind && shouldNotify(idle) && !api.paused()) {
      n++;
      const b = BREAKS[kind];
      api.island.notice({ text: b.text, priority: BAND.NOTICE, ms: 8000, key: "break", view: "eyecare", peek: true });
      if (!api.island.busy()) api.avatar.emote(b.emote);
    }
    arm();
  };
  arm();
  return () => { alive = false; timer?.(); };
}

export const eyecareModule: ModuleDef = {
  id: "eyecare",
  views: [{ name: "eyecare", layout: { height: 190, botX: 54, botY: null, botDiameter: 46 }, build: (ctx) => buildView(ctx) }],
  tabs: [{ view: "eyecare", title: "Pausas", icon: () => svg(ICONS.pulse, 13, { stroke: 2 }), order: 100 }],
  start,
};
