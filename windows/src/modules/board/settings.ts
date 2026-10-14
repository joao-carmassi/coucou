// The Início section of the settings window (only while the board is on): which provider is the home's
// default primary. Only providers that are on are listed; a saved one that went off is ignored and
// the board falls back to the existing order.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";

/** Board-capable providers (they answer board.card for their pills), in catalog order. */
export const BOARD_PROVIDERS: { id: string; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "github", label: "GitHub" },
  { id: "vercel", label: "Vercel" },
  { id: "stripe", label: "Stripe" },
  { id: "n8n", label: "n8n" },
  { id: "resend", label: "Resend" },
  { id: "calcom", label: "Cal.com" },
  { id: "notion", label: "Notion" },
];

interface Own { boardPrimary: string; modulesEnabled: Record<string, boolean> }

function boardSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const { boardPrimary, modulesEnabled } = ms.get<Own>();
  const on = BOARD_PROVIDERS.filter((p) => modulesEnabled?.[p.id] === true || (p.id === "claude" && modulesEnabled?.claude !== false));
  const sel = h("select", {}, ...on.map((p) => h("option", { value: p.id, text: p.label }))) as HTMLSelectElement;
  sel.value = on.some((p) => p.id === boardPrimary) ? boardPrimary : "claude";
  sel.addEventListener("change", () => void ms.save({ boardPrimary: sel.value }));
  return {
    el: h("section", { id: "board" },
      h("h2", {}, h("span", { text: "Início" })),
      h("div", { class: "row" }, h("label", { text: "Principal da Início" }), sel),
      h("div", { class: "hint", text: "O que fica na área grande da Início. Clicar numa pílula a traz para a frente até o tempo de foco passar." }),
    ),
  };
}

export const settingsSections = { board: boardSettingsSection };
