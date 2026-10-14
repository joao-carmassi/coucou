// The Voz section of the settings window (rendered only while the module is on).
// The speech model is downloaded only on the button; the microphone opens only on the hotkey.

import { onEvent } from "../../core/bridge";
import { VoiceBridge } from "./bridge";
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../views/dom";

/** Rust keeps the hotkey in `extra`: absent = the default (settingsDefaults), "" = off. */
export function voiceSettingsSection(ms: ModuleSettings): { el: HTMLElement; dispose(): void } {
  const status = h("span", { class: "hint" });
  const err = h("div", { class: "notice warn", style: "display:none" });
  const dl = h("button", { class: "btn secondary", text: "Baixar modelo (~20 MB)" }) as HTMLButtonElement;
  const showError = (msg: string) => {
    err.style.display = msg ? "" : "none";
    err.textContent = msg;
  };
  const refresh = async () => {
    const st = await VoiceBridge.voiceModelStatus();
    status.textContent = st?.ready ? "Modelo instalado." : "Modelo não instalado.";
    dl.disabled = !!st?.ready;
    showError(st?.hotkeyError ?? "");
  };
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    status.textContent = "Baixando…";
    try {
      await VoiceBridge.voiceDownloadModel();
    } catch (e) {
      status.textContent = String(e).replace(/^Error:\s*/, "");
      dl.disabled = false;
      return;
    }
    void refresh();
  });
  const input = h("input", {
    type: "text", value: ms.get<{ voiceHotkey: string }>().voiceHotkey, spellcheck: "false", placeholder: "ex.: Ctrl+Alt+V",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    // Rust tries the new combo on save; the verdict comes back as `hotkey-error`.
    void ms.save({ voiceHotkey: input.value.trim() }).then(() => setTimeout(() => void refresh(), 300));
  });

  const offs = [
    onEvent<{ file: string; received: number; total: number }>("voice-download", (p) => {
      status.textContent = `Baixando ${p.file}… ${p.total ? Math.round((100 * p.received) / p.total) + "%" : ""}`;
    }),
    onEvent<{ name: string; error: string }>("hotkey-error", (p) => { if (p.name === "voice") showError(p.error); }),
  ];
  void refresh();
  const el = h("section", { id: "voice" },
    h("h2", {}, h("span", { text: "Voz" })),
    h("div", { class: "row" },
      h("label", { text: "Atalho de voz" }),
      input,
      h("span", { class: "hint", text: "Entrada de voz em inglês, reconhecida no próprio computador; o microfone só abre quando você aperta o atalho. Ex.: Ctrl+Alt+V. Aperte de novo (ou Enter) para finalizar; Esc cancela. Vazio = sem atalho." }),
    ),
    h("div", { class: "row" }, h("label", { text: "Modelo de voz" }), dl, status),
    err,
  );
  return { el, dispose: () => offs.forEach((o) => void o.then((off) => off())) };
}

export const settingsSections = { voice: voiceSettingsSection };
