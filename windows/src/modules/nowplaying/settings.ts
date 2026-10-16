// The Tocando agora section of the settings window: the Mochi dance and how strongly it reacts. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { clampSens, SENS_MAX, SENS_MIN, type Cfg } from "./logic";

function nowplayingSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  let on = cfg.nowplayingDance !== false;
  const sw = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": "Mochi dança no ritmo" });
  sw.addEventListener("click", () => {
    on = !on;
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-pressed", String(on));
    void ms.save({ nowplayingDance: on });
  });
  const range = h("input", { type: "range", min: SENS_MIN, max: SENS_MAX, step: 0.1, value: clampSens(cfg.nowplayingSensitivity), "aria-label": "Sensibilidade" }) as HTMLInputElement;
  range.addEventListener("change", () => void ms.save({ nowplayingSensitivity: clampSens(range.value) }));
  return {
    el: h("section", { id: "nowplaying" },
      h("h2", {}, h("span", { text: "Tocando agora" })),
      h("div", { class: "row" }, h("label", { text: "Mochi dança no ritmo" }), sw),
      h("div", { class: "row" }, h("label", { text: "Sensibilidade" }), range),
      h("p", { class: "hint", text: "O som que sai do PC é analisado só na memória, enquanto a ilha está visível e algo toca. Nada é gravado ou enviado, e o microfone nunca é usado." })),
  };
}

export const settingsSections = { nowplaying: nowplayingSettingsSection };
