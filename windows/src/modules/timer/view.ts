import { h, clear, replay } from "../../views/dom";
import { card } from "../../views/views";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import type { TimerClock } from "./timer";

function btn(label: string, kind: "primary" | "secondary", onClick: () => void): HTMLElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}

/** The Timer tab: pick a time (or stopwatch) -> ready page with Iniciar -> running page with Pausar. */
export function buildTimerView(Timer: TimerClock, ctx: ViewContext): ViewHost {
  const body = h("div", { class: "stack" });
  body.style.padding = "4px 16px 4px 84px";
  const el = h("div", { class: "view" }, card(null, body));
  const label = h("div", { class: "timer-label" });
  const readout = h("div", { class: "timer-readout" });
  const fill = h("i");
  const bar = h("div", { class: "timer-progress" }, fill);
  let key = "";
  const draw = () => {
    const next = Timer.status;
    clear(body);
    el.classList.toggle("paused", next === "paused");
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
      body.append(
        h("div", { class: "title", text: "Timer" }),
        h("div", { class: "sub", text: "Escolha um tempo ou digite os minutos." }),
        h("div", { class: "actions timer-row" },
          ...[5, 10, 25].map((m) => btn(`${m} min`, "secondary", () => Timer.prepare("countdown", m))),
          mins, btn("Ok", "secondary", go), h("div", { class: "grow" }),
          h("button", { class: "link-btn text-link", text: "Cronômetro", onclick: () => Timer.prepare("stopwatch") })),
      );
    } else {
      const stopwatch = Timer.kind === "stopwatch";
      label.textContent = (stopwatch ? "Cronômetro" : `Timer · ${Math.round(Timer.total / 60_000)} min`) + (next === "paused" ? " · pausado" : "");
      bar.hidden = stopwatch;
      const main = next === "ready" ? btn("Iniciar", "primary", () => Timer.start())
        : btn(next === "running" ? "Pausar" : "Retomar", "secondary", () => (next === "running" ? Timer.pause() : Timer.resume()));
      body.append(
        label,
        h("div", { class: "actions timer-row" },
          readout, h("div", { class: "grow" }), main,
          h("button", { class: "link-btn text-link", text: "Cancelar", onclick: () => Timer.cancel() })),
        bar,
      );
    }
  };
  return {
    el,
    sync() {
      // Nothing is touched while the tab is hidden.
      if (ctx.api.island.view() !== "timer") return;
      if (Timer.status !== key) { key = Timer.status; draw(); }
      if (key === "idle") return;
      readout.textContent = Timer.text();
      fill.style.width = `${Math.max(1.5, Timer.fraction() * 100)}%`;
    },
  };
}
