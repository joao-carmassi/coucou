// The voice card: "microfone aberto", then the transcript inline (read-only). The transcript always
// waits for Enter (the module's key listener calls send), Esc or "Aguardar" (parks it hidden), never a timer; Enter launches a NEW Claude Code session; nothing here types into
// an existing one. State lives here (one voice at a time); the module resets it on start/stop.

import { CLAUDE_SERVICE, type LaunchPrompt } from "../claude/api";
import { VoiceBridge } from "./bridge";
import type { IslandApi, ViewContext, ViewHost } from "../../core/moduleApi";
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";

export type Phase = "none" | "listening" | "transcribing" | "review" | "sending" | "error";

export const Voice = {
  phase: "none" as Phase,
  text: "",
  note: "",
  busy: false,
  /** Flow's own take, apart from the card: "" | "listening" | "transcribing". */
  flow: "",
  level: null as HTMLElement | null,
  /** Review is over (sent or cancelled): the module lets go of the pin and folds the island. */
  leave: (() => {}) as () => void,
  /** "Aguardar": hide the island, keep the transcript for later. */
  park: (() => {}) as () => void,
  reset() {
    this.phase = "none";
    this.text = this.note = "";
    this.busy = false;
    this.flow = "";
    this.level = null;
    this.leave = this.park = () => {};
  },
};

const button = (label: string, kind: "primary" | "secondary", onclick: () => void) =>
  h("button", { class: `btn ${kind}`, onclick }, h("span", { text: label }));

export async function send(api: IslandApi) {
  Voice.text = Voice.text.trim();
  if (Voice.busy || !Voice.text) return;
  Voice.busy = true;
  try {
    const launch = api.use<LaunchPrompt>(CLAUDE_SERVICE.launchPrompt);
    // No claude module: the same Enter copies the text instead.
    if (launch) await launch(Voice.text);
    else await navigator.clipboard.writeText(Voice.text);
    Voice.phase = "none";
    Voice.leave();
  } catch (err) {
    Voice.phase = "error";
    Voice.note = String(err).replace(/^Error:\s*/, "");
  } finally {
    Voice.busy = false;
    api.island.redraw();
  }
}

const NAMES: Record<string, string> = { pt: "português", en: "inglês", es: "espanhol", fr: "francês", de: "alemão", it: "italiano" };

/** What to tell the user to speak: the light engine is English-only, whisper follows the chosen language. */
export function speakHint(engine: string, language: string): string {
  if (engine !== "whisper") return "Fale em inglês";
  return NAMES[language] ? `Fale em ${NAMES[language]}` : "Fale no seu idioma";
}

export function buildVoiceView(ctx: ViewContext): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const meter = h("div", { style: "height:4px;width:140px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden" },
    h("div", { style: "height:100%;width:0;background:#ef4444;transition:width .1s" }));
  Voice.level = meter.firstElementChild as HTMLElement;
  const actions = h("div", { style: "display:flex;gap:8px;margin-top:6px" });
  const text = h("div", { style: "display:none;max-height:64px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px" });
  const body = h("div", { class: "stack", style: "padding:0 18px 0 100px" }, title, text, sub, meter, actions);
  const el = view(card(null, body));
  const done = () => { Voice.phase = "none"; Voice.leave(); };

  return {
    el,
    sync() {
      clear(actions);
      const cfg = ctx.api.settings<{ voiceEngine: string; voiceLanguage: string }>();
      const canSend = !!ctx.api.use<LaunchPrompt>(CLAUDE_SERVICE.launchPrompt);
      meter.style.display = Voice.phase === "listening" ? "" : "none";
      sub.textContent = "";
      const review = Voice.phase === "review";
      text.style.display = review ? "" : "none";
      title.style.display = review ? "none" : "";
      text.textContent = review ? Voice.text : "";
      switch (Voice.phase) {
        case "listening":
          title.textContent = "● Microfone aberto";
          sub.textContent = `${speakHint(cfg.voiceEngine, cfg.voiceLanguage)}, sem pressa. Enter ou atalho finaliza · Esc cancela.`;
          actions.append(button("Finalizar", "secondary", () => void VoiceBridge.voiceStop()));
          break;
        case "transcribing":
          title.textContent = "Transcrevendo…";
          break;
        case "review":
          sub.textContent = `Enter ${canSend ? "envia" : "copia"} · Esc cancela`;
          actions.append(button(canSend ? "Enviar" : "Copiar", "primary", () => void send(ctx.api)), button("Aguardar", "secondary", () => Voice.park()));
          break;
        case "sending":
          title.textContent = "Enviando…";
          break;
        case "error":
          title.textContent = "Voz";
          sub.textContent = Voice.note;
          actions.append(button("OK", "secondary", done));
          break;
        default:
          title.textContent = "";
      }
    },
  };
}
