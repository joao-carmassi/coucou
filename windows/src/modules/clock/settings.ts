// The Relógio section of the settings window (only while the module is on).
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { formatOf } from "./format";

function clockSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const sel = h("select", {},
    h("option", { value: "24h", text: "24 horas" }), h("option", { value: "12h", text: "12 horas (AM/PM)" })) as HTMLSelectElement;
  sel.value = formatOf(ms.get());
  sel.addEventListener("change", () => {
    void ms.save({ clockFormat: sel.value });
  });
  return { el: h("section", { id: "clock" }, h("h2", {}, h("span", { text: "Relógio" })), h("div", { class: "row" }, h("label", { text: "Formato da hora" }), sel)) };
}

export const settingsSections = { clock: clockSettingsSection };
