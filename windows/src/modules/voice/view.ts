// Voice input on the island: the "microfone aberto" card, the transcript, and where it goes.
// The transcript always waits for a click (Enviar).
// "Enviar" because it launches a new session. Nothing here types into an existing session.

import { h, clear } from "../../views/dom";
import { Bridge, onEvent } from "../../core/bridge";
import { State } from "../../core/state";
import type { Island } from "../../island/island";
import type { ViewHost } from "../../views/views";

type Phase = "none" | "listening" | "transcribing" | "review" | "sending" | "error";
let phase: Phase = "none";
let text = "";
let note = "";
let busy = false;
let levelEl: HTMLElement | null = null;
let isl: Island | null = null;

/** The transcript card is up and waiting for Enviar/Cancelar. */
export const voiceReviewing = () => phase === "review";

/** Review is over: let go of the pin and fall back to whatever the island should show. */
const leaveReview = () => isl?.afterRequest(true);

export function buildVoice(): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const meter = h("div", { style: "height:4px;width:140px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden" },
    h("div", { style: "height:100%;width:0;background:#ef4444;transition:width .1s" }));
  levelEl = meter.firstElementChild as HTMLElement;
  const actions = h("div", { style: "display:flex;gap:8px;margin-top:6px" });
  const body = h("div", { class: "stack", style: "padding:0 18px 0 100px" }, title, sub, meter, actions);
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));

  const button = (label: string, kind: "primary" | "secondary", onclick: () => void) =>
    h("button", { class: `btn ${kind}`, onclick }, h("span", { text: label }));

  return {
    el,
    sync() {
      clear(actions);
      meter.style.display = phase === "listening" ? "" : "none";
      sub.textContent = "";
      switch (phase) {
        case "listening":
          title.textContent = "● Microfone aberto";
          sub.textContent = "Fale em inglês. Uma pausa de 1 s fecha a frase.";
          actions.append(button("Parar", "secondary", () => void Bridge.voiceStop()));
          break;
        case "transcribing":
          title.textContent = "Transcrevendo…";
          break;
        case "review":
          title.textContent = `“${text}”`;
          sub.textContent = "Abre uma nova sessão do Claude Code com este texto.";
          actions.append(
            button("Enviar", "primary", () => void send()),
            button("Cancelar", "secondary", () => { phase = "none"; leaveReview(); }),
          );
          break;
        case "sending":
          title.textContent = "Enviando…";
          break;
        case "error":
          title.textContent = "Voz";
          sub.textContent = note;
          break;
        default:
          title.textContent = "";
      }
    },
  };
}

async function send() {
  if (busy || !text) return;
  busy = true;
  try {
    const profiles = (await Bridge.claudeProfiles()) ?? [];
    const profile = (profiles.find((p) => p.isDefault) ?? profiles[0])?.key ?? "";
    await Bridge.sessionLaunch({ profile, cwd: null, resume: null, attach: null, prompt: text });
    phase = "none";
    leaveReview();
  } catch (err) {
    phase = "error";
    note = String(err).replace(/^Error:\s*/, "");
  } finally {
    busy = false;
    State.notify();
  }
}

export function registerVoiceHandlers(island: Island) {
  isl = island;
  void onEvent<{ state: string; message: string }>("voice-state", ({ state, message }) => {
    if (state === "listening") phase = "listening";
    else if (state === "transcribing") phase = "transcribing";
    else if (state === "error") { phase = "error"; note = message; }
    else {
      // idle: nothing was heard closes the card; a transcript waiting for a click stays.
      if (phase === "listening" || phase === "transcribing") { phase = "none"; if (State.view === "voice") island.collapse(); }
      return;
    }
    // A request card in front keeps the island: the phase is set, the card is not taken over.
    if (State.view !== "approval" && State.view !== "question") island.alert("voice");
  });
  void onEvent<number>("voice-level", (v) => {
    if (levelEl && phase === "listening") levelEl.style.width = `${Math.round(v * 100)}%`;
  });
  void onEvent<{ text: string }>("voice-text", ({ text: t }) => {
    text = t;
    phase = "review"; State.isPinned = true; island.alert("voice");
  });
}
