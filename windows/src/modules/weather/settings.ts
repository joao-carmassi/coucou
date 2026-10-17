// The Clima section of the settings window: city (search, then pick) and units. Must not import index.ts.
// Only the chosen city's coordinates leave the machine (the forecast request); the search text goes to the geocoder.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { glanceMinutes, placeLabel } from "./logic";
import type { Place, Units, WeatherCfg } from "./logic";
import { weatherBridge } from "./bridge";

function weatherSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<WeatherCfg>();
  let place: Place | null = cfg.weatherPlace ?? null;
  let units: Units = cfg.weatherUnits === "F" ? "F" : "C";

  const current = h("div", { class: "sub", text: place ? `Cidade: ${placeLabel(place)}` : "Nenhuma cidade escolhida." });
  const note = h("div", { class: "sub" });
  const results = h("div", { class: "stack" });
  const query = h("input", { class: "island-field", type: "text", placeholder: "Nome da cidade", autocomplete: "off", maxlength: 100 }) as HTMLInputElement;

  const choose = (p: Place) => {
    place = p;
    results.replaceChildren();
    current.textContent = `Cidade: ${placeLabel(p)}`;
    void ms.save({ weatherPlace: p }).then(() => (note.textContent = ""));
  };
  const search = async () => {
    const q = query.value.trim();
    if (!q) return;
    note.textContent = "Buscando…";
    results.replaceChildren();
    try {
      const found = (await weatherBridge.search(q)) ?? [];
      note.textContent = found.length ? "Escolha uma cidade:" : "Nenhuma cidade encontrada.";
      for (const p of found) results.append(h("button", { class: "btn secondary", text: placeLabel(p), onclick: () => choose(p) }));
    } catch (err) {
      note.textContent = String(err);
    }
  };
  query.addEventListener("keydown", (e) => e.key === "Enter" && void search());

  const unit = (u: Units, label: string) => {
    const el = h("button", { class: u === units ? "btn primary" : "btn secondary", text: label, "aria-pressed": u === units });
    el.addEventListener("click", () => {
      units = u;
      void ms.save({ weatherUnits: u }).then(() => {
        for (const b of unitsRow.querySelectorAll("button")) b.className = b === el ? "btn primary" : "btn secondary";
      });
    });
    return el;
  };
  const unitsRow = h("div", { class: "actions" }, unit("C", "Celsius"), unit("F", "Fahrenheit"));

  const glance = h("select", {}, ...[[0, "Desligado"], [15, "A cada 15 min"], [30, "A cada 30 min"], [60, "A cada 1 h"], [120, "A cada 2 h"]]
    .map(([v, t]) => h("option", { value: String(v), text: String(t) }))) as HTMLSelectElement;
  glance.value = String(glanceMinutes(cfg.weatherGlanceEvery));
  glance.addEventListener("change", () => void ms.save({ weatherGlanceEvery: Number(glance.value) }));

  return {
    el: h("section", { id: "weather" },
      h("h2", {}, h("span", { text: "Clima" })),
      current,
      h("div", { class: "row" }, h("label", { text: "Buscar cidade" }), query,
        h("button", { class: "btn secondary", text: "Buscar", onclick: () => void search() })),
      note,
      results,
      h("div", { class: "row" }, h("label", { text: "Temperatura" }), unitsRow),
      h("div", { class: "row" }, h("label", { text: "Mostrar o clima na ilha" }), glance),
      h("div", { class: "sub", text: "Só as coordenadas da cidade escolhida são enviadas ao Open-Meteo: ao abrir a aba Clima e, se ativado acima, a cada intervalo (mesmo com a ilha oculta)." })),
  };
}

export const settingsSections = { weather: weatherSettingsSection };
