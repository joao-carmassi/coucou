// The Pausas section of the settings window. Must not import index.ts.
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";
import { command } from "../../kit/tauri";
import { BREAKS, KIND_ORDER, enabledKinds, intervalMin, parseExcluded, type BreakKind } from "./logic";

type Cfg = { eyecareInterval: unknown; eyecareKinds: unknown; eyecareExcluded: unknown; eyecareKeepDays: unknown };

function eyecareSettingsSection(ms: ModuleSettings): { el: HTMLElement } {
  const cfg = ms.get<Cfg>();
  const kinds = new Set<BreakKind>(enabledKinds(cfg.eyecareKinds));
  const row = (label: string, ...kids: HTMLElement[]) => h("div", { class: "row" }, h("label", { text: label }), ...kids);
  const toggle = (kind: BreakKind) => {
    const el = h("button", { class: kinds.has(kind) ? "switch on" : "switch", "aria-pressed": kinds.has(kind), "aria-label": BREAKS[kind].label });
    el.addEventListener("click", () => {
      if (!kinds.delete(kind)) kinds.add(kind);
      el.classList.toggle("on", kinds.has(kind));
      el.setAttribute("aria-pressed", String(kinds.has(kind)));
      void ms.save({ eyecareKinds: KIND_ORDER.filter((k) => kinds.has(k)) });
    });
    return row(`Lembrete: ${BREAKS[kind].label.toLowerCase()}`, el);
  };
  const interval = h("input", { type: "number", min: 0, max: 60, value: intervalMin(cfg.eyecareInterval) }) as HTMLInputElement;
  interval.addEventListener("change", () => {
    const v = intervalMin(interval.value);
    interval.value = String(v);
    void ms.save({ eyecareInterval: v });
  });
  const keep = h("input", { type: "number", min: 1, max: 90, value: Number(cfg.eyecareKeepDays) || 30 }) as HTMLInputElement;
  keep.addEventListener("change", () => {
    const v = Math.min(90, Math.max(1, Math.floor(Number(keep.value)) || 30));
    keep.value = String(v);
    void ms.save({ eyecareKeepDays: v });
  });
  const excluded = h("input", { type: "text", placeholder: "app.exe, outro.exe", value: (Array.isArray(cfg.eyecareExcluded) ? cfg.eyecareExcluded : []).join(", ") }) as HTMLInputElement;
  excluded.addEventListener("change", () => void ms.save({ eyecareExcluded: parseExcluded(excluded.value) }));
  const wipe = h("button", { class: "btn secondary", text: "Apagar dados" });
  let armed = false;
  wipe.addEventListener("click", () => {
    if (!armed) { armed = true; wipe.textContent = "Clique de novo para apagar"; return; }
    armed = false;
    wipe.textContent = "Apagar dados";
    void command("eyecare_clear");
  });
  wipe.addEventListener("blur", () => { armed = false; wipe.textContent = "Apagar dados"; });
  return {
    el: h("section", { id: "eyecare" },
      h("h2", {}, h("span", { text: "Pausas" })),
      row("Lembrar a cada (min, 0 = desligado)", interval),
      ...KIND_ORDER.map(toggle),
      row("Não contar tempo de tela destes apps", excluded),
      row("Guardar tempo de tela por (dias)", keep),
      row("Tempo de tela guardado", wipe),
      h("p", { class: "hint", text: "Só o nome do programa e os segundos ficam guardados, neste computador. Nada é enviado." })),
  };
}

export const settingsSections = { eyecare: eyecareSettingsSection };
