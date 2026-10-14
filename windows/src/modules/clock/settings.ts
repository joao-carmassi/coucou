// The Relógio section of the settings window (only while the module is on).
import { Bridge } from "../../core/bridge";
import { State } from "../../core/state";
import { h } from "../../views/dom";
import { formatOf } from "./format";

function clockSettingsSection(): { el: HTMLElement } {
  const sel = h("select", {},
    h("option", { value: "24h", text: "24 horas" }), h("option", { value: "12h", text: "12 horas (AM/PM)" })) as HTMLSelectElement;
  sel.value = formatOf(State.settings);
  sel.addEventListener("change", () => {
    (State.settings as unknown as { clockFormat: string }).clockFormat = sel.value;
    void Bridge.saveSettings(State.settings);
  });
  return { el: h("section", { id: "clock" }, h("h2", {}, h("span", { text: "Relógio" })), h("div", { class: "row" }, h("label", { text: "Formato da hora" }), sel)) };
}

export const settingsSections = { clock: clockSettingsSection };
