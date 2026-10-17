// The Voz section of the settings window (rendered only while the module is on).
// Speech models are downloaded only on a click; the microphone opens only on the hotkey. Everything runs on this PC.

import { onEvent } from "../../kit/tauri";
import { VoiceBridge } from "./bridge";
import type { SettingsUi } from "../../core/moduleApi";
import type { ModuleSettings } from "../../core/moduleSettings";
import { h } from "../../kit/dom";

export const LANGUAGES: readonly (readonly [string, string])[] = [
  ["auto", "Automático"], ["pt", "Português"], ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"],
];

/** Pinned downloads, shown before the click (the same values Rust verifies). */
const WHISPER_FILES = [
  { host: "github.com", what: "whisper.cpp b5454 (whisper-cli, Windows x64)", size: "8,9 MB", sha: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb" },
  { host: "huggingface.co", what: "modelo ggml-base-q5_1.bin", size: "59,7 MB", sha: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898" },
];

/** Rust keeps these keys in `extra`: absent = the default (settingsDefaults), "" = off. */
export function voiceSettingsSection(ms: ModuleSettings, ui: SettingsUi): { el: HTMLElement; dispose(): void } {
  const cur = () => ms.get<{ voiceHotkey: string; voiceEngine: string; voiceLanguage: string; voiceFlowEnabled: boolean; voiceAssistHotkey: string; voiceSpeak: boolean }>();
  const status = h("span", { class: "hint" });
  const wstatus = h("span", { class: "hint" });
  const err = h("div", { class: "notice warn", style: "display:none" });
  const dl = h("button", { class: "btn secondary", text: "Baixar modelo (~20 MB)" }) as HTMLButtonElement;
  const wdl = h("button", { class: "btn secondary", text: "Baixar Whisper (~69 MB)" }) as HTMLButtonElement;
  const showError = (msg: string) => {
    err.style.display = msg ? "" : "none";
    err.textContent = msg;
  };

  const engine = h("select", {}, h("option", { value: "whistle", text: "Inglês (leve, ~20 MB)" }), h("option", { value: "whisper", text: "Whisper, vários idiomas (~69 MB)" })) as HTMLSelectElement;
  engine.value = cur().voiceEngine === "whisper" ? "whisper" : "whistle";
  const lang = h("select", {}, ...LANGUAGES.map(([v, t]) => h("option", { value: v, text: t }))) as HTMLSelectElement;
  lang.value = LANGUAGES.some(([v]) => v === cur().voiceLanguage) ? cur().voiceLanguage : "auto";

  const rowWhistle = h("div", { class: "row" }, h("label", { text: "Modelo de voz" }), dl, status);
  const files = h("div", { class: "hint", style: "display:block;margin-top:4px;user-select:text" },
    ...WHISPER_FILES.map((f) => h("div", { text: `${f.host}: ${f.what}, ${f.size}, SHA-256 ${f.sha}` })));
  const rowWhisper = h("div", { class: "row" }, h("label", { text: "Whisper" }), wdl, wstatus, files);
  const apply = () => {
    const w = engine.value === "whisper";
    lang.disabled = !w;
    rowWhistle.style.display = w ? "none" : "";
    rowWhisper.style.display = w ? "" : "none";
  };
  apply();
  engine.addEventListener("change", () => { apply(); void ms.save({ voiceEngine: engine.value }); });
  lang.addEventListener("change", () => void ms.save({ voiceLanguage: lang.value }));

  const refresh = async () => {
    const st = await VoiceBridge.voiceModelStatus();
    status.textContent = st?.ready ? "Modelo instalado." : "Modelo não instalado.";
    dl.disabled = !!st?.ready;
    wstatus.textContent = st?.whisperReady ? "Whisper instalado." : "Whisper não instalado.";
    wdl.disabled = !!st?.whisperReady;
    showError(st?.hotkeyError ?? "");
  };
  const download = (btn: HTMLButtonElement, out: HTMLElement, run: () => Promise<void>) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    out.textContent = "Baixando…";
    try {
      await run();
    } catch (e) {
      out.textContent = String(e).replace(/^Error:\s*/, "");
      btn.disabled = false;
      return;
    }
    void refresh();
  });
  download(dl, status, VoiceBridge.voiceDownloadModel);
  download(wdl, wstatus, VoiceBridge.voiceDownloadWhisper);

  let flowOn = cur().voiceFlowEnabled === true;
  const flow = h("button", { class: flowOn ? "switch on" : "switch", "aria-pressed": flowOn, "aria-label": "Ditado em qualquer app (Ctrl direito)" });
  flow.addEventListener("click", () => {
    flowOn = !flowOn;
    flow.classList.toggle("on", flowOn);
    flow.setAttribute("aria-pressed", String(flowOn));
    void ms.save({ voiceFlowEnabled: flowOn });
  });

  const assist = h("input", {
    type: "text", value: cur().voiceAssistHotkey, spellcheck: "false", placeholder: "ex.: Ctrl+Alt+Space (vazio = desligado)",
  }) as HTMLInputElement;
  assist.addEventListener("change", () => {
    void ms.save({ voiceAssistHotkey: assist.value.trim() }).then(() => ui.timeout(() => void refresh(), 300));
  });
  let speakOn = cur().voiceSpeak === true;
  const speak = h("button", { class: speakOn ? "switch on" : "switch", "aria-pressed": speakOn, "aria-label": "Falar a confirmação" });
  speak.addEventListener("click", () => {
    speakOn = !speakOn;
    speak.classList.toggle("on", speakOn);
    speak.setAttribute("aria-pressed", String(speakOn));
    void ms.save({ voiceSpeak: speakOn });
  });

  const input = h("input", {
    type: "text", value: cur().voiceHotkey, spellcheck: "false", placeholder: "ex.: Ctrl+Alt+V",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    // Rust tries the new combo on save; the verdict comes back as `hotkey-error`.
    void ms.save({ voiceHotkey: input.value.trim() }).then(() => ui.timeout(() => void refresh(), 300));
  });

  const offs = [
    onEvent<{ file: string; received: number; total: number }>("voice-download", (p) => {
      const t = `Baixando ${p.file}… ${p.total ? Math.round((100 * p.received) / p.total) + "%" : ""}`;
      (p.file.startsWith("ggml-") || p.file.startsWith("whisper-") ? wstatus : status).textContent = t;
    }),
    onEvent<{ name: string; error: string }>("hotkey-error", (p) => { if (p.name === "voice") showError(p.error); }),
  ];
  void refresh();
  const el = h("section", { id: "voice" },
    h("h2", {}, h("span", { text: "Voz" })),
    h("div", { class: "row" },
      h("label", { text: "Atalho de voz" }),
      input,
      h("span", { class: "hint", text: "Tudo roda neste computador: a única conexão é o download que você clica, de github.com e huggingface.co. O microfone só abre quando você aperta o atalho. Ex.: Ctrl+Alt+V. Aperte de novo (ou Enter) para finalizar; Esc cancela. Vazio = sem atalho." }),
    ),
    h("div", { class: "row" }, h("label", { text: "Motor" }), engine),
    h("div", { class: "row" }, h("label", { text: "Idioma" }), lang, h("span", { class: "hint", text: "Só o Whisper escolhe idioma; o motor leve entende apenas inglês." })),
    rowWhistle,
    rowWhisper,
    h("div", { class: "row" },
      h("label", { text: "Ditado em qualquer app (Ctrl direito)" }),
      flow,
      h("span", { class: "hint", text: "Segure o Ctrl direito e fale; solte para colar o texto no app em foco. Dois toques rápidos = mãos livres; um toque encerra; Esc cancela. Usa um gancho de teclado do Windows; nenhuma tecla é gravada; o texto é colado no app em foco e a área de transferência é restaurada; apps rodando como administrador não recebem a colagem." }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Atalho do assistente" }),
      assist,
      h("span", { class: "hint", text: "Diga o nome de um comando do Coucou (ex.: \"próxima faixa\") e ele é executado. Só roda comandos que os módulos registraram; nada fora dessa lista. Sem correspondência, o texto fica no cartão para você copiar ou enviar. Não há palavra de ativação: o microfone só abre no atalho." }),
    ),
    h("div", { class: "row" }, h("label", { text: "Falar a confirmação" }), speak, h("span", { class: "hint", text: "Lê em voz alta \"Feito: …\" com a voz padrão do Windows, depois de um comando do assistente." })),
    err,
  );
  return { el, dispose: () => offs.forEach((o) => void o.then((off) => off())) };
}

export const settingsSections = { voice: voiceSettingsSection };
