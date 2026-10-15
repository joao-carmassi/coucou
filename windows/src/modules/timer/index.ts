import { svg } from "../../kit/dom";
import "./timer.css";
import { ICONS } from "../../kit/icons";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { TimerClock } from "./timer";
import { buildTimerView, type PomoUi } from "./view";
import { pomoCfg, pomoLabel, pomoMinutes, pomoNext, pomoStart, type PomoState } from "./pomodoro";
import { ALARM_GRACE_MS, alarmText, nextAlarm, parseAlarms } from "./alarms";

interface Cfg { timerPomodoro: unknown; timerPomodoroAuto: boolean; timerFocusPomodoro: boolean; timerAlarms: unknown }

// State lives here (not in State); the object is inert until start() gives it an onChange.
const Timer = new TimerClock();
// Pomodoro phase on top of the countdown; null = a plain timer / stopwatch.
let pomo: PomoState | null = null;
let readCfg: () => Cfg = () => ({ timerPomodoro: null, timerPomodoroAuto: true, timerFocusPomodoro: false, timerAlarms: [] });
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
  let alarmT: Disposer | null = null;
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
  // Alarms: ONE timeout, for the next fire time only (recomputed from Date: midnight and DST safe).
  // Re-armed after firing, a settings save and a visibility change (a wake from sleep shows up as one).
  // A pending alarm is kept across re-arms; only a changed fire time (or settings) replaces the timeout.
  let pending: ReturnType<typeof nextAlarm> = null;
  const fire = (p: NonNullable<typeof pending>) => {
    const late = Date.now() - p.at, text = alarmText(p.alarms);
    if (late < ALARM_GRACE_MS) {
      api.sound.play("alert");
      api.island.notice({ text: `Alarme ${text}`, priority: BAND.NOTICE + 10, key: "alarm", ms: 8000, peek: true });
    } else api.island.notice({ text: `Alarme perdido ${text}`, priority: BAND.NOTICE, key: "alarm", ms: 8000 });
  };
  const armAlarm = (force = false) => {
    // The machine slept past it: ring (or report it as missed) now, before choosing the next one.
    if (pending && pending.at <= Date.now()) { const p = pending; pending = null; alarmT?.(); alarmT = null; fire(p); }
    const next = nextAlarm(parseAlarms(readCfg().timerAlarms), new Date());
    if (!force && alarmT && next && pending && next.at === pending.at) return;
    alarmT?.(); alarmT = null; pending = next;
    if (!next) return;
    // 2^31-1 is setTimeout's ceiling; waking early only re-arms.
    alarmT = api.timeout(() => {
      alarmT = null;
      if (Date.now() >= next.at) { pending = null; fire(next); }
      armAlarm();
    }, Math.min(Math.max(0, next.at - Date.now()), 2 ** 31 - 1));
  };
  armAlarm();
  // Deferred: the settings snapshot may not have the saved keys yet when the event arrives.
  const offSettings = api.listen("settings-changed", () => void api.timeout(() => armAlarm(true), 0));
  const offKeep = api.island.keepAwake(() => Timer.active);
  // Alt+F / palette: a focus phase (pomodoro when "Iniciar foco usa Pomodoro" is on, else a 25 min countdown), only while nothing is running.
  const offAction = api.actions.add({
    id: "focus", title: "Iniciar foco", keywords: ["timer", "pomodoro", "temporizador"], key: "f",
    when: () => !Timer.active && !(pomo && Timer.status === "ready"), // a ready pomodoro phase waits for its own click
    run() {
      if (readCfg().timerFocusPomodoro) startPomo();
      else {
        pomo = null; Timer.prepare("countdown", 25); Timer.start(); }
    },
  });
  // The interval is off while hidden: catch the readout up when the island comes back.
  const offVis = api.onVisibility((mode) => { armAlarm(); if (mode !== "hidden" && Timer.status === "running") refresh(); });
  return () => {
    disarm();
    alarmT?.();
    offSettings();
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
