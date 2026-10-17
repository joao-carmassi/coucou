// The Agentes section of the settings window. Must not import index.ts.
// Every write is: preview (exact diff + backup path) -> explicit click -> write, and a file that
// changed in between is refused by Rust (the fingerprint).
import "./agents.css";
import type { SettingsUi } from "../../core/moduleApi";
import type { ModuleSettings } from "../../core/moduleSettings";
import { clear, h } from "../../kit/dom";
import { AgentsBridge, type AgentRow } from "./bridge";

type Cfg = { agentsApprove: unknown; agentsNotify: unknown };

const NOTES: Record<string, string> = {
  codex: "Depois de instalar, abra o Codex e rode /hooks para confiar nos hooks do Coucou. Aprovação pela ilha disponível.",
  cursor: "Com o hook instalado, o Cursor passa a perguntar antes de cada comando de shell; com a aprovação ligada, você responde pela ilha. Se o Coucou estiver fechado, o Cursor pergunta normalmente.",
  gemini: "Só acompanha: o Gemini CLI não permite aprovar por hook.",
  copilot: "Só acompanha: a aprovação pela ilha ainda não foi verificada no Copilot CLI.",
  opencode: "Só acompanha. Instala um pequeno plugin na pasta de plugins do OpenCode.",
};

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "agents-diff" });
  for (const line of text.split("\n")) {
    box.append(h("div", { class: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx", text: line }));
  }
  return box;
}

const dotOf = (ok: boolean) => h("i", { class: "dot", style: `background:${ok ? "var(--green)" : "var(--red)"}` });

function agentsSection(ms: ModuleSettings, ui: SettingsUi): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h("section", { id: "agents", class: "agents-section" }, h("h2", {}, h("span", { text: "Agentes" })), list);

  const toggle = (label: string, key: keyof Cfg) => {
    let on = cfg[key] === true;
    const sw = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on, "aria-label": label });
    sw.addEventListener("click", () => {
      on = !on;
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-pressed", String(on));
      void ms.save({ [key]: on });
    });
    return h("div", { class: "row" }, h("label", { text: label }), sw);
  };

  async function review(row: AgentRow, install: boolean) {
    clear(list);
    const back = () => void draw();
    try {
      const p = await AgentsBridge.preview(row.id, install);
      const confirm = h("button", { class: install ? "primary" : "danger", text: install ? "Fazer backup e gravar" : "Fazer backup e remover" });
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        try {
          const backup = await AgentsBridge.apply(row.id, install, p.fingerprint);
          clear(list);
          list.append(h("div", { class: "agents-note ok", text: `Pronto.${backup ? ` Versão anterior salva como ${backup}.` : ""} Abra uma nova sessão de ${row.label} para valer.` }));
          ui.timeout(back, 2600);
        } catch (err) {
          confirm.disabled = false;
          list.append(h("div", { class: "agents-note err", text: `Não foi possível gravar: ${String(err)}` }));
        }
      });
      list.append(
        h("div", { class: "hint", text: install ? `É exatamente isto que vai mudar em ${p.settingsPath}. O que não é do Coucou fica intacto.` : "Isso remove só o que é do Coucou. O resto fica intacto." }),
        renderDiff(p.diff),
        h("div", { class: "row" }, h("span", { class: "path", text: `Backup → ${p.backup}` })),
        h("div", { class: "row" }, confirm, h("button", { text: "Cancelar", onclick: back })),
      );
    } catch (err) {
      list.append(h("div", { class: "agents-note err", text: String(err).replace(/^Error:\s*/, "") }), h("div", { class: "row" }, h("button", { text: "Voltar", onclick: back })));
    }
  }

  async function draw() {
    const rows = await AgentsBridge.list();
    clear(list);
    list.append(toggle("Aprovar permissões pela ilha (Codex e Cursor)", "agentsApprove"), toggle("Avisar quando um agente terminar", "agentsNotify"));
    for (const r of rows) {
      const act = h("div", { class: "agents-row" },
        h("button", { class: "primary", text: r.hooked ? "Reinstalar hooks…" : "Instalar hooks…", onclick: () => void review(r, true) }),
        r.hooked ? h("button", { class: "danger", text: "Remover hooks…", onclick: () => void review(r, false) }) : null);
      list.append(h("div", { style: "display:flex;flex-direction:column;gap:6px" },
        h("div", { class: "agents-row" }, dotOf(r.hooked), h("b", { text: r.label }),
          h("span", { class: "hint", text: !r.installed ? "não encontrado neste PC" : r.hooked ? "conectado" : "não conectado" }),
          h("span", { class: "hint", text: r.blocking ? "aprovação" : "só acompanha" })),
        h("span", { class: "path", text: r.configPath }),
        h("span", { class: "hint", text: NOTES[r.id] ?? "" }),
        act));
    }
  }
  void draw();
  return { el: section };
}

export const settingsSections = { agents: agentsSection };
