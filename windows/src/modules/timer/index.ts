import { svg } from "../../kit/dom";
import "./timer.css";
import { ICONS } from "../../kit/icons";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { TimerClock } from "./timer";
import { buildTimerView } from "./view";

// State lives here (not in State); the object is inert until start() gives it an onChange.
const Timer = new TimerClock();

function start(api: IslandApi): Disposer {
  let tick: Disposer | null = null;
  let done: Disposer | null = null;
  let hold: Disposer | null = null;
  const refresh = () => {
    api.status.set(Timer.active ? { priority: 50, text: Timer.text(), overGrid: true } : null);
    api.island.redraw();
  };
  const disarm = () => { tick?.(); done?.(); tick = done = null; };
  const finish = () => {
    done = null;
    Timer.cancel(); // onChange -> arm -> idle
    api.sound.play("finish");
    // A request waiting keeps the island: the sound is enough then.
    if (!api.island.busy()) api.island.notice({ text: "Temporizador concluído", priority: BAND.NOTICE, view: "timer" });
  };
  const arm = () => {
    disarm();
    // A configured-but-unstarted timer is still a task in progress.
    if (Timer.status !== "idle") {
      // Sticky until finished or cancelled. Re-added on each arm (idempotent: same owner+view replaces), so a hold the home tab cleared is retaken.
      hold = api.island.hold("timer");
    } else { hold?.(); hold = null; }
    if (Timer.status === "running") {
      // One-shot, so the end still rings (and is shown) if the island is hidden.
      if (Timer.kind === "countdown") done = api.timeout(finish, Timer.remaining());
      tick = api.interval(refresh, 1000, { whenVisible: true });
    }
    refresh();
  };
  Timer.reset();
  Timer.onChange = arm;
  const offKeep = api.island.keepAwake(() => Timer.active);
  // The interval is off while hidden: catch the readout up when the island comes back.
  // Alt+F / palette: a 25 min countdown, only while nothing is running.
  const offAction = api.actions.add({
    id: "focus", title: "Iniciar foco", keywords: ["timer", "pomodoro", "temporizador"], key: "f",
    when: () => !Timer.active,
    run() { Timer.prepare("countdown", 25); Timer.start(); },
  });
  const offVis = api.onVisibility((mode) => { if (mode !== "hidden" && Timer.status === "running") refresh(); });
  return () => {
    disarm();
    hold?.();
    offKeep();
    offAction();
    offVis();
    Timer.reset();
    api.status.set(null);
  };
}

export const timerModule: ModuleDef = {
  id: "timer",
  views: [{
    name: "timer",
    layout: { height: 160, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildTimerView(Timer, ctx),
  }],
  tabs: [{ view: "timer", title: "Timer", icon: () => svg(ICONS.dial, 13), order: 30 }],
  start,
};
