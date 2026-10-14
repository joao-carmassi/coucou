// The Início section of the settings window (only while the board is on): which module's pill is the
// home's default primary. The list comes from the catalog (every module but the board, so new
// integrations show up by themselves); one that is off is ignored at runtime and the board falls back
// to the existing order.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { MODULE_INFO } from "../catalog";

interface Own { boardPrimary: string; modulesEnabled: Record<string, boolean> }

function boardSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const sel = h("select", {}) as HTMLSelectElement;
  // Rebuilt from a fresh read each time the list is about to open; the saved value is always an option.
  const fill = () => {
    const { boardPrimary: saved, modulesEnabled } = ms.get<Own>();
    const on = MODULE_INFO.filter((m) => m.id !== "board" && (modulesEnabled?.[m.id] ?? m.defaultEnabled));
    const opts = on.map((m) => ({ id: m.id, label: m.label }));
    if (!opts.some((o) => o.id === saved)) opts.push({ id: saved, label: MODULE_INFO.find((m) => m.id === saved)?.label ?? saved });
    sel.replaceChildren(...opts.map((o) => h("option", { value: o.id, text: o.label })));
    sel.value = saved;
  };
  fill();
  sel.addEventListener("focus", fill);
  sel.addEventListener("pointerdown", fill);
  sel.addEventListener("change", () => void ms.save({ boardPrimary: sel.value }));
  return {
    el: h("section", { id: "board" },
      h("h2", {}, h("span", { text: "Início" })),
      h("div", { class: "row" }, h("label", { text: "Principal do Início" }), sel),
      h("div", { class: "hint", text: "O que fica na área grande do Início. Clicar numa pílula a traz para a frente até o tempo de foco passar." }),
    ),
  };
}

export const settingsSections = { board: boardSettingsSection };
