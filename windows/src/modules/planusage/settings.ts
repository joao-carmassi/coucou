// The Uso do plano section of the settings window. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";

function planusageSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  let on = ms.get<{ planusageClaudeNet: boolean }>().planusageClaudeNet === true;
  const sw = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": "Consultar o uso do Claude pela internet" });
  sw.addEventListener("click", () => {
    on = !on;
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-pressed", String(on));
    void ms.save({ planusageClaudeNet: on });
  });
  return {
    el: h("section", { id: "planusage" },
      h("h2", {}, h("span", { text: "Uso do plano" })),
      h("div", { class: "hint", text: "O uso do Codex é lido dos arquivos locais da sessão (~/.codex), sem internet." }),
      h("div", { class: "row" }, h("label", { text: "Mostrar também o uso do Claude (usa a internet)" }), sw),
      h("div", { class: "hint", text: "Atenção: usa a internet, lê o token de login do Claude Code e consulta api.anthropic.com. Esse endereço não é oficial e pode parar de funcionar. Só consulta com a aba Uso do plano aberta ou ao clicar em Atualizar, no máximo a cada 5 minutos. O token nunca é renovado, salvo nem enviado a outro lugar." })),
  };
}

export const settingsSections = { planusage: planusageSettingsSection };
