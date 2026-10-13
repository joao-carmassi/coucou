// The voice card: "microfone aberto", the transcript, and where it goes. The transcript always
// waits for a click (Enviar), which launches a NEW Claude Code session; nothing here types into
// an existing one. State lives here (one voice at a time); the module resets it on start/stop.

import { Bridge } from "../../core/bridge";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { State } from "../../core/state";
import { h, clear } from "../../views/dom";

export type Phase = "none" | "listening" | "transcribing" | "review" | "sending" | "error";

export const Voice = {
  phase: "none" as Phase,
  text: "",
  note: "",
  busy: false,
  level: null as HTMLElement | null,
  /** Review is over (sent or cancelled): the module lets go of the pin and folds the island. */
  leave: (() => {}) as () => void,
  reset() {
    this.phase = "none";
    this.text = this.note = "";
    this.busy = false;
    this.level = null;
    this.leave = () => {};
  },
};

const button = (label: string, kind: "primary" | "secondary", onclick: () => void) =>
  h("button", { class: `btn ${kind}`, onclick }, h("span", { text: label }));

async function send() {
  if (Voice.busy || !Voice.text) return;
  Voice.busy = true;
  try {
    const profiles = (await Bridge.claudeProfiles()) ?? [];
    const profile = (profiles.find((p) => p.isDefault) ?? profiles[0])?.key ?? "";
    await Bridge.sessionLaunch({ profile, cwd: null, resume: null, attach: null, prompt: Voice.text });
    Voice.phase = "none";
    Voice.leave();
  } catch (err) {
    Voice.phase = "error";
    Voice.note = String(err).replace(/^Error:\s*/, "");
  } finally {
    Voice.busy = false;
    State.notify();
  }
}

export function buildVoiceView(_ctx: ViewContext): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const meter = h("div", { style: "height:4px;width:140px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden" },
    h("div", { style: "height:100%;width:0;background:#ef4444;transition:width .1s" }));
  Voice.level = meter.firstElementChild as HTMLElement;
  const actions = h("div", { style: "display:flex;gap:8px;margin-top:6px" });
  const body = h("div", { class: "stack", style: "padding:0 18px 0 100px" }, title, sub, meter, actions);
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));
  const done = () => { Voice.phase = "none"; Voice.leave(); };

  return {
    el,
    sync() {
      clear(actions);
      meter.style.display = Voice.phase === "listening" ? "" : "none";
      sub.textContent = "";
      switch (Voice.phase) {
        case "listening":
          title.textContent = "● Microfone aberto";
          sub.textContent = "Fale em inglês. Uma pausa de 1 s fecha a frase.";
          actions.append(button("Parar", "secondary", () => void Bridge.voiceStop()));
          break;
        case "transcribing":
          title.textContent = "Transcrevendo…";
          break;
        case "review":
          title.textContent = `“${Voice.text}”`;
          sub.textContent = "Abre uma nova sessão do Claude Code com este texto.";
          actions.append(button("Enviar", "primary", () => void send()), button("Cancelar", "secondary", done));
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
