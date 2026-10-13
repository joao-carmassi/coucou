// Voice module: hotkey (Rust) -> listening -> transcript -> review card -> "Enviar" launches a
// Claude session with the text. Needs the claude module (catalog `requires`).

import type { Disposer, IslandApi, ModuleDef } from "../../core/moduleApi";
import { State } from "../../core/state";
import { voiceSettingsSection } from "./settings";
import { buildVoiceView, Voice } from "./view";

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
    if (api.island.mode() === "expanded") api.island.setView("voice");
    else api.island.open("voice");
  };
  Voice.leave = () => {
    State.isPinned = false;
    line();
    api.island.close();
  };
  const offs: Disposer[] = [
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
      line();
      show();
    }),
    // The transcript stays reachable (a close or a hover does not lose it) until Enviar/Cancelar.
    api.provide("homeView", () => (reviewing() ? { view: "voice", pin: true, priority: 40 } : null)),
    api.island.keepAwake(reviewing),
  ];
  return () => {
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
