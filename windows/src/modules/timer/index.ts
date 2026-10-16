import { svg } from "../../kit/dom";
import "./timer.css";
import { ICONS } from "../../kit/icons";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { TimerClock } from "./timer";
import { buildTimerView, type PomoUi } from "./view";
import { pomoCfg, pomoLabel, pomoMinutes, pomoNext, pomoStart, type PomoState } from "./pomodoro";

interface Cfg { timerPomodoro: unknown; timerPomodoroAuto: boolean }

// State lives here (not in State); the object is inert until start() gives it an onChange.
const Timer = new TimerClock();
// Pomodoro phase on top of the countdown; null = a plain timer / stopwatch.
let pomo: PomoState | null = null;
let readCfg: () => Cfg = () => ({ timerPomodoro: null, timerPomodoroAuto: true });
const pomoUi: PomoUi = {
  label: () => (pomo ? pomoLabel(pomo, pomoCfg(readCfg().timerPomodoro)) : null),
  start: () => startPomo(),
  skip: () => skipPomo(),
  stop: () => { pomo = null; Timer.cancel(); },
};
let startPomo = () => {};
let skipPomo = () => {};

function start(api: IslandApi): Disposer {
  let tick: Disposer | null = null;
  let done: Disposer | null = null;
  let hold: Disposer | null = null;
  const refresh = () => {
    api.status.set(Timer.active ? { priority: 50, text: Timer.text(), overGrid: true } : null);
    api.island.redraw();
  };
  const disarm = () => { tick?.(); done?.(); tick = done = null; };
  // Next phase: running at once, or ready (a click starts it) when timerPomodoroAuto is false.
  const advance = (text: string | null) => {
    const c = readCfg(), cfg = pomoCfg(c.timerPomodoro);
    pomo = pomoNext(pomo!, cfg);
    if (text !== null) api.sound.play("finish"); // a skip is the user's own click: silent
    if (text !== null && !api.island.busy()) api.island.notice({ text: `${text} · ${pomoLabel(pomo, cfg)}`, priority: BAND.NOTICE, view: "timer", key: "pomodoro" });
    Timer.prepare("countdown", pomoMinutes(pomo, cfg)); // onChange -> arm: the hold stays
    if (c.timerPomodoroAuto !== false) Timer.start();
  };
  startPomo = () => {
    pomo = pomoStart();
    Timer.prepare("countdown", pomoMinutes(pomo, pomoCfg(readCfg().timerPomodoro)));
    Timer.start();
  };
  skipPomo = () => { if (pomo) advance(null); };
  const finish = () => {
    done = null;
    if (pomo) return advance("Fase concluída");
    Timer.cancel(); // onChange -> arm -> idle
    api.sound.play("finish");
    // A request waiting keeps the island: the sound is enough then.
    if (!api.island.busy()) api.island.notice({ text: "Temporizador concluído", priority: BAND.NOTICE, view: "timer" });
  };
  const arm = () => {
    disarm();
    if (Timer.status === "idle" || Timer.kind !== "countdown") pomo = null;
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
  pomo = null;
  readCfg = () => api.settings<Cfg>();
  Timer.onChange = arm;
  const offKeep = api.island.keepAwake(() => Timer.active);
  // Alt+F / palette: a pomodoro work phase, only while nothing is running.
  const offAction = api.actions.add({
    id: "focus", title: "Iniciar foco", keywords: ["timer", "pomodoro", "temporizador"], key: "f",
    when: () => !Timer.active && !(pomo && Timer.status === "ready"), // a ready pomodoro phase waits for its own click
    run: () => startPomo(),
  });
  // The interval is off while hidden: catch the readout up when the island comes back.
  const offVis = api.onVisibility((mode) => { if (mode !== "hidden" && Timer.status === "running") refresh(); });
  return () => {
    disarm();
    hold?.();
    offKeep();
    offAction();
    offVis();
    Timer.reset();
    pomo = null;
    api.status.set(null);
  };
}

export const timerModule: ModuleDef = {
  id: "timer",
  views: [{
    name: "timer",
    layout: { height: 160, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildTimerView(Timer, ctx, pomoUi),
  }],
  tabs: [{ view: "timer", title: "Timer", icon: () => svg(ICONS.dial, 13), order: 30 }],
  start,
};
