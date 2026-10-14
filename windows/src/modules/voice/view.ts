// The voice card: "microfone aberto", the transcript, and where it goes. The transcript always
// waits for Enter (or the Enviar button), never a timer, which launches a NEW Claude Code session; nothing here types into
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
  Voice.text = Voice.text.trim();
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
  const field = h("textarea", { rows: "2", spellcheck: "false", style: "display:none;width:100%;resize:none" }) as HTMLTextAreaElement;
  const body = h("div", { class: "stack", style: "padding:0 18px 0 100px" }, title, field, sub, meter, actions);
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));
  const done = () => { Voice.phase = "none"; Voice.leave(); };
  // Enter sends, Esc cancels, Shift+Enter is a newline. No timer ever sends.
  field.addEventListener("input", () => { Voice.text = field.value; });
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
    else if (e.key === "Escape") done();
  });
  field.addEventListener("blur", () => void Bridge.focusWindow(false));
  let editing = false;

  return {
    el,
    sync() {
      clear(actions);
      meter.style.display = Voice.phase === "listening" ? "" : "none";
      sub.textContent = "";
      const review = Voice.phase === "review";
      field.style.display = review ? "" : "none";
      title.style.display = review ? "none" : "";
      if (review && !editing) {
        editing = true;
        field.value = Voice.text;
        void Bridge.focusWindow(true);
        setTimeout(() => field.focus(), 80);
      } else if (!review) editing = false;
      switch (Voice.phase) {
        case "listening":
          title.textContent = "● Microfone aberto";
          sub.textContent = "Fale em inglês. Uma pausa de 1 s fecha a gravação; nada é enviado sem Enter.";
          actions.append(button("Parar", "secondary", () => void Bridge.voiceStop()));
          break;
        case "transcribing":
          title.textContent = "Transcrevendo…";
          break;
        case "review":
          sub.textContent = "Enter envia · Esc cancela · Shift+Enter quebra linha";
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
