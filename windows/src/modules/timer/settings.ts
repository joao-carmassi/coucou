// The Timer section of the settings window: pomodoro lengths and alarms. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { parseAlarms, type Alarm } from "./alarms";
import { pomoCfg, type PomoCfg } from "./pomodoro";

const DAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
type Cfg = { timerPomodoro: unknown; timerPomodoroAuto: boolean; timerFocusPomodoro: boolean; timerAlarms: unknown };

function timerSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  const pomo: PomoCfg = pomoCfg(cfg.timerPomodoro);
  let alarms: Alarm[] = parseAlarms(cfg.timerAlarms);
  const toggle = (on: boolean, change: (v: boolean) => void) => {
    const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
    el.addEventListener("click", () => { on = !on; el.classList.toggle("on", on); el.setAttribute("aria-pressed", String(on)); change(on); });
    return el;
  };
  const num = (label: string, key: keyof PomoCfg, max: number) => {
    const i = h("input", { type: "number", min: 1, max, value: pomo[key] }) as HTMLInputElement;
    i.addEventListener("change", () => {
      const n = Math.floor(Number(i.value));
      if (n >= 1 && n <= max) { pomo[key] = n; void ms.save({ timerPomodoro: { ...pomo } }); } else i.value = String(pomo[key]);
    });
    return h("div", { class: "row" }, h("label", { text: label }), i);
  };
  const saveAlarms = () => void ms.save({ timerAlarms: alarms.map((a) => ({ ...a })) });
  const list = h("div", {});
  const draw = () => {
    list.replaceChildren(...alarms.map((a) => {
      const time = h("input", { type: "time", value: a.time }) as HTMLInputElement;
      time.addEventListener("change", () => { if (/^\d\d:\d\d$/.test(time.value)) { a.time = time.value; saveAlarms(); } });
      const label = h("input", { type: "text", value: a.label, placeholder: "Nome", maxlength: 40 }) as HTMLInputElement;
      label.addEventListener("change", () => { a.label = label.value; saveAlarms(); });
      const days = DAYS.map((d, n) => {
        const b = h("button", { class: a.days.includes(n) ? "btn primary" : "btn secondary", text: d, title: "Dias (nenhum = todos)" });
        b.addEventListener("click", () => {
          a.days = a.days.includes(n) ? a.days.filter((x) => x !== n) : [...a.days, n].sort();
          b.className = a.days.includes(n) ? "btn primary" : "btn secondary";
          saveAlarms();
        });
        return b;
      });
      const del = h("button", { class: "btn secondary", text: "Remover" });
      del.addEventListener("click", () => { alarms = alarms.filter((x) => x !== a); saveAlarms(); draw(); });
      return h("div", { class: "row" }, toggle(a.on, (v) => { a.on = v; saveAlarms(); }), time, label, ...days, del);
    }));
  };
  draw();
  const add = h("button", { class: "btn secondary", text: "Novo alarme" });
  add.addEventListener("click", () => {
    alarms = [...alarms, { id: `a${Date.now().toString(36)}`, time: "08:00", label: "", days: [], on: true }];
    saveAlarms(); draw();
  });
  return {
    el: h("section", { id: "timer" },
      h("h2", {}, h("span", { text: "Timer" })),
      num("Foco (min)", "work", 600), num("Pausa curta (min)", "short", 600), num("Pausa longa (min)", "long", 600),
      num("Pausa longa a cada (ciclos)", "every", 24),
      h("div", { class: "row" }, h("label", { text: "Iniciar a próxima fase sozinho" }),
        toggle(cfg.timerPomodoroAuto !== false, (v) => void ms.save({ timerPomodoroAuto: v }))),
      h("div", { class: "row" }, h("label", { text: "\"Iniciar foco\" usa o Pomodoro" }),
        toggle(!!cfg.timerFocusPomodoro, (v) => void ms.save({ timerFocusPomodoro: v }))),
      h("h2", {}, h("span", { text: "Alarmes" })), list, add),
  };
}

export const settingsSections = { timer: timerSettingsSection };
