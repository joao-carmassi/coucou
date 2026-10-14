// The voice card: "microfone aberto", then the transcript inline (read-only). The transcript always
// waits for Enter (the module's key listener calls send), Esc or "Aguardar" (parks it hidden), never a timer; Enter launches a NEW Claude Code session; nothing here types into
// an existing one. State lives here (one voice at a time); the module resets it on start/stop.

import { ClaudeBridge } from "../claude/bridge";
import { VoiceBridge } from "./bridge";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { State } from "../../core/state";
import { h, clear } from "../../kit/dom";

export type Phase = "none" | "listening" | "transcribing" | "review" | "sending" | "error";

export const Voice = {
  phase: "none" as Phase,
  text: "",
  note: "",
  busy: false,
  level: null as HTMLElement | null,
  /** Review is over (sent or cancelled): the module lets go of the pin and folds the island. */
  leave: (() => {}) as () => void,
  /** "Aguardar": hide the island, keep the transcript for later. */
  park: (() => {}) as () => void,
  reset() {
    this.phase = "none";
    this.text = this.note = "";
    this.busy = false;
    this.level = null;
    this.leave = this.park = () => {};
  },
};

const button = (label: string, kind: "primary" | "secondary", onclick: () => void) =>
  h("button", { class: `btn ${kind}`, onclick }, h("span", { text: label }));

export async function send() {
  Voice.text = Voice.text.trim();
  if (Voice.busy || !Voice.text) return;
  Voice.busy = true;
  try {
    const profiles = (await ClaudeBridge.claudeProfiles()) ?? [];
    const profile = (profiles.find((p) => p.isDefault) ?? profiles[0])?.key ?? "";
    await ClaudeBridge.sessionLaunch({ profile, cwd: null, resume: null, attach: null, prompt: Voice.text });
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
  const text = h("div", { style: "display:none;max-height:64px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px" });
  const body = h("div", { class: "stack", style: "padding:0 18px 0 100px" }, title, text, sub, meter, actions);
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));
  const done = () => { Voice.phase = "none"; Voice.leave(); };

  return {
    el,
    sync() {
      clear(actions);
      meter.style.display = Voice.phase === "listening" ? "" : "none";
      sub.textContent = "";
      const review = Voice.phase === "review";
      text.style.display = review ? "" : "none";
      title.style.display = review ? "none" : "";
      text.textContent = review ? Voice.text : "";
      switch (Voice.phase) {
        case "listening":
          title.textContent = "● Microfone aberto";
          sub.textContent = "Fale em inglês, sem pressa. Enter ou atalho finaliza · Esc cancela.";
          actions.append(button("Finalizar", "secondary", () => void VoiceBridge.voiceStop()));
          break;
        case "transcribing":
          title.textContent = "Transcrevendo…";
          break;
        case "review":
          sub.textContent = "Enter envia · Esc cancela";
          actions.append(button("Aguardar", "secondary", () => Voice.park()));
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
