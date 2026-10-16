// The Timer section of the settings window: pomodoro lengths. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { pomoCfg, type PomoCfg } from "./pomodoro";

type Cfg = { timerPomodoro: unknown; timerPomodoroAuto: boolean };

function timerSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  const pomo: PomoCfg = pomoCfg(cfg.timerPomodoro);
  const toggle = (on: boolean, change: (v: boolean) => void, name = "") => {
    const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": name || undefined });
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
  return {
    el: h("section", { id: "timer" },
      h("h2", {}, h("span", { text: "Timer" })),
      num("Foco (min)", "work", 600), num("Pausa curta (min)", "short", 600), num("Pausa longa (min)", "long", 600),
      num("Pausa longa a cada (ciclos)", "every", 24),
      h("div", { class: "row" }, h("label", { text: "Iniciar a próxima fase sozinho" }),
        toggle(cfg.timerPomodoroAuto !== false, (v) => void ms.save({ timerPomodoroAuto: v }), "Iniciar a próxima fase sozinho"))),
  };
}

export const settingsSections = { timer: timerSettingsSection };
