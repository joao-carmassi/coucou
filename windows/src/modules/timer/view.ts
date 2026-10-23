import { h, svg, clear, replay } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import type { TimerClock } from "./timer";

// Glyphs only this view draws (24x24 grid): play and pause filled, stopwatch and tomato stroked.
const PLAY = "M8 5.2v13.6L18.8 12z";
const PAUSE = "M6.8 5h3.7v14H6.8zm6.7 0h3.7v14h-3.7z";
const STOPWATCH = "M10 2.8h4M12 2.8v3.7M18.3 7.2l1.4-1.4M12 13.5v-3.3M12 6.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z";
const TOMATO = "M12 7.2V4.4M8.8 5.7 12 7.2l3.2-1.5M12 7.2a6.9 6.9 0 1 0 0 13.8 6.9 6.9 0 0 0 0-13.8z";

function btn(label: string, kind: "primary" | "secondary", onClick: () => void, icon?: string): HTMLElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, icon ? svg(icon, 11) : false, h("span", { text: label }));
}
const link = (text: string, onClick: () => void, icon?: string) =>
  h("button", { class: icon ? "link-btn text-link timer-mode" : "link-btn text-link", onclick: onClick }, icon ? svg(icon, 15, { stroke: 1.7 }) : false, text);

export interface PomoUi { label(): string | null; start(): void; skip(): void; stop(): void }

/** The Timer tab: pick a time (or stopwatch) -> ready page with Iniciar -> running page with Pausar.
 *  The body's class names the status (timer-idle / -ready / -running / -paused); timer.css styles each. */
export function buildTimerView(Timer: TimerClock, ctx: ViewContext, pomo: PomoUi): ViewHost {
  const body = h("div", { class: "stack timer-body" });
  body.style.padding = "4px 16px 4px 84px";
  const el = view(card(null, body));
  const label = h("div", { class: "timer-label" });
  const readout = h("div", { class: "timer-readout" });
  const fill = h("i");
  const bar = h("div", { class: "timer-progress" }, fill);
  let key = "";
  const draw = () => {
    const next = Timer.status;
    clear(body);
    body.className = `stack timer-body timer-${next}`;
    replay(body, "timer-swap"); // restart the short fade on every redraw
    if (next === "idle") {
      // A choice goes straight to the ready page: nothing runs until "Iniciar".
      const mins = h("input", { class: "island-field timer-min", type: "number", min: 1, max: 600, placeholder: "min", autocomplete: "off" }) as HTMLInputElement;
      const go = () => {
        const m = Math.floor(Number(mins.value));
        if (m >= 1 && m <= 600) Timer.prepare("countdown", m);
        else mins.style.borderColor = "var(--red)";
      };
      mins.addEventListener("input", () => (mins.style.borderColor = ""));
      mins.addEventListener("keydown", (e) => e.key === "Enter" && go());
      // A tile reads "5 min" as a whole (textContent), drawn as a big number over a small unit.
      const preset = (m: number) => h("button", { class: "btn secondary timer-preset", onclick: () => Timer.prepare("countdown", m) },
        h("b", { text: String(m) }), h("small", { text: " min" }));
      body.append(
        h("div", { class: "timer-head" },
          h("div", { class: "title", text: "Timer" }),
          h("div", { class: "sub", text: "Escolha um tempo ou digite os minutos." })),
        h("div", { class: "actions timer-row" },
          ...[5, 10, 25].map(preset),
          h("div", { class: "timer-custom" }, mins, btn("Ok", "secondary", go)),
          h("div", { class: "grow" }),
          h("div", { class: "timer-modes" },
            link("Cronômetro", () => Timer.prepare("stopwatch"), STOPWATCH),
            link("Pomodoro", () => pomo.start(), TOMATO))),
      );
    } else {
      const stopwatch = Timer.kind === "stopwatch";
      const phase = pomo.label();
      label.textContent = phase ? phase + (next === "ready" ? " · pronto" : next === "paused" ? " · pausado" : "") : (stopwatch ? "Cronômetro" : `Timer · ${Math.round(Timer.total / 60_000)} min`) + (next === "paused" ? " · pausado" : "");
      bar.hidden = stopwatch;
      // White while a click is awaited (start, resume); quiet while it runs.
      const main = next === "ready" ? btn("Iniciar", "primary", () => Timer.start(), PLAY)
        : next === "running" ? btn("Pausar", "secondary", () => Timer.pause(), PAUSE)
        : btn("Retomar", "primary", () => Timer.resume(), PLAY);
      body.append(
        label,
        h("div", { class: "actions timer-row" },
          readout, h("div", { class: "grow" }), main,
          phase ? link("Pular", () => pomo.skip()) : false,
          link(phase ? "Parar" : "Cancelar", () => (phase ? pomo.stop() : Timer.cancel()))),
        bar,
      );
    }
  };
  return {
    el,
    sync() {
      // Nothing is touched while the tab is hidden.
      if (ctx.api.island.view() !== "timer") return;
      const k = Timer.status + (pomo.label() ?? ""); // a pomodoro phase change keeps the status "running"
      if (k !== key) { key = k; draw(); }
      if (Timer.status === "idle") return;
      readout.textContent = Timer.text();
      fill.style.transform = `scaleX(${Math.max(0.015, Timer.fraction())})`; // a transform: no layout while it moves
    },
  };
}
