// Voice module: hotkey (Rust) -> listening (until Enter/hotkey; Esc cancels) -> transcript -> transcript inline on the voice card -> Enter launches a
// Claude session with the text. Needs the claude module (catalog `requires`).

import type { Disposer, IslandApi, ModuleDef } from "../../core/moduleApi";
import { Bridge } from "../../core/bridge";
import { VoiceBridge } from "./bridge";
import { State } from "../../core/state";
import { voiceSettingsSection } from "./settings";
import { buildVoiceView, send, Voice } from "./view";

const reviewing = () => Voice.phase === "review";
const STATUS: Partial<Record<string, string>> = { listening: "ouvindo…", transcribing: "transcrevendo…", review: "voz: revisar" };

function start(api: IslandApi): Disposer {
  // No reset here: the view is built before start() and already writes Voice.level; stop resets.
  const line = () => {
    const text = STATUS[Voice.phase];
    api.status.set(text ? { priority: 40, text } : null);
  };
  // A request card in front keeps the island: the phase is set, the card is not taken over.
  const show = () => {
    const v = api.island.view();
    if (v === "approval" || v === "question") return;
    // Pinned in every phase: open() hands the pin to the state machine, which setView alone never did
    // (an already open card kept its auto-close timer and folded while the transcript was on it).
    State.isPinned = true;
    api.island.open("voice");
  };
  // Enter/Esc are captured only while listening or while a transcript is on the card: the listener exists
  // only then (never while parked/hidden) and the window takes focus (Bridge.focusWindow) so the keys reach it while the user typed elsewhere.
  let offKeys: Disposer | null = null;
  const keys = (on: boolean) => {
    if (on === !!offKeys) return;
    void Bridge.focusWindow(on);
    if (!on) { offKeys?.(); offKeys = null; return; }
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (api.island.view() !== "voice") return; // a request card in front owns the keys
      const listening = Voice.phase === "listening";
      if (!listening && !reviewing()) return;
      if (e.key === "Enter") { e.preventDefault(); if (listening) void VoiceBridge.voiceStop(); else void send(); }
      else if (e.key === "Escape") {
        e.preventDefault();
        if (listening) void VoiceBridge.voiceCancel();
        Voice.phase = "none";
        Voice.leave();
      }
    };
    window.addEventListener("keydown", onKey);
    offKeys = () => window.removeEventListener("keydown", onKey);
  };
  Voice.leave = () => {
    keys(false);
    State.isPinned = false;
    line();
    api.island.close();
  };
  // "Aguardar": hide the island, keep the transcript. No timer is left behind; the keys are released
  // (onVisibility) and come back when the island opens on the card again.
  Voice.park = () => { keys(false); api.island.close(); };
  const offs: Disposer[] = [
    api.onVisibility((mode) => {
      if (!reviewing()) return;
      keys(mode === "expanded");
      if (mode === "expanded" && api.island.view() !== "voice") api.island.setView("voice");
    }),
    // Hotkey while not recording: bring a waiting transcript back, else start listening.
    api.listen("voice-hotkey", () => {
      if (reviewing()) { keys(false); show(); keys(true); return; }
      VoiceBridge.voiceStart().catch((e) => { Voice.phase = "error"; Voice.note = String(e).replace(/^Error:\s*/, ""); State.isPinned = true; line(); show(); });
    }),
    api.listen<{ state: string; message: string }>("voice-state", ({ state, message }) => {
      if (state === "listening") Voice.phase = "listening";
      else if (state === "transcribing") Voice.phase = "transcribing";
      else if (state === "error") { Voice.phase = "error"; Voice.note = message; State.isPinned = true; }
      else {
        // idle: nothing was heard closes the card; a transcript waiting for a click stays.
        if (Voice.phase === "listening" || Voice.phase === "transcribing") {
          Voice.phase = "none";
          line();
          if (api.island.view() === "voice") api.island.close();
        }
        return;
      }
      keys(state === "listening");
      line();
      show();
    }),
    api.listen<number>("voice-level", (v) => {
      if (Voice.level && Voice.phase === "listening") Voice.level.style.width = `${Math.round(v * 100)}%`;
    }),
    api.listen<{ text: string }>("voice-text", ({ text }) => {
      Voice.text = text;
      Voice.phase = "review";
      State.isPinned = true;
      keys(true);
      line();
      show();
    }),
    // The transcript stays reachable (a close or a hover does not lose it) until Enter/Esc.
    api.provide("homeView", () => (reviewing() ? { view: "voice", pin: true, priority: 40 } : null)),
  ];
  return () => {
    keys(false);
    for (const off of offs.reverse()) off();
    api.status.set(null);
    Voice.reset();
  };
}

export const voiceModule: ModuleDef = {
  id: "voice",
  label: "Voz",
  defaultEnabled: false,
  requires: ["claude"],
  views: [{
    name: "voice",
    layout: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
    build: buildVoiceView,
  }],
  settings: voiceSettingsSection,
  start,
};
