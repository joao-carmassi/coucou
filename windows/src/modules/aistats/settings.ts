// The Estatísticas de IA section of the settings window. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { command } from "../../kit/tauri";
import { keepDays } from "./logic";

function aistatsSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const keep = h("input", { type: "number", min: 1, max: 365, value: keepDays(ms.get<{ aistatsKeepDays: unknown }>().aistatsKeepDays) }) as HTMLInputElement;
  keep.addEventListener("change", () => {
    const v = keepDays(keep.value);
    keep.value = String(v);
    void ms.save({ aistatsKeepDays: v });
  });
  const wipe = h("button", { class: "btn secondary", text: "Apagar estatísticas" });
  let armed = false;
  wipe.addEventListener("click", () => {
    if (!armed) { armed = true; wipe.textContent = "Clique de novo para apagar"; return; }
    armed = false;
    wipe.textContent = "Apagar estatísticas";
    void command("aistats_clear");
  });
  wipe.addEventListener("blur", () => { armed = false; wipe.textContent = "Apagar estatísticas"; });
  const row = (label: string, el: HTMLElement) => h("div", { class: "row" }, h("label", { text: label }), el);
  return {
    el: h("section", { id: "aistats" },
      h("h2", {}, h("span", { text: "Estatísticas de IA" })),
      row("Guardar estatísticas por (dias)", keep),
      row("Estatísticas guardadas", wipe),
      h("p", { class: "hint", text: "Lê os registros locais do Claude Code e do Codex só quando a aba abre. Ficam guardados só números, nomes de modelo e nomes de pastas, neste computador. Nada é enviado. A pasta do Claude vem de CLAUDE_CONFIG_DIR (ou ~/.claude), não da configuração do módulo Claude." })),
  };
}

export const settingsSections = { aistats: aistatsSettingsSection };
