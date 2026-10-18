// Flow (dictate into any app with the right Ctrl): the Rust side owns the keys and the paste. Here only the status line
// ("ditando…") and the avatar meter follow `voice-flow`. The listener exists only while `voiceFlowEnabled` is on.

import type { Disposer, IslandApi } from "../../core/moduleApi";
import { Voice } from "./view";

interface FlowEvent { state: string; chars: number; message: string }

export const FLOW_STATUS: Partial<Record<string, string>> = { listening: "ditando…", transcribing: "transcrevendo…" };

/** Follows the setting (now and on every save). `hooks.line` redraws the status line; `hooks.error` shows a failure on the card. */
export function bindFlow(api: IslandApi, hooks: { line(): void; error(message: string): void }): Disposer {
  let off: Disposer | null = null;
  const sync = () => {
    const on = api.settings<{ voiceFlowEnabled: boolean }>().voiceFlowEnabled === true;
    if (on && !off) {
      off = api.listen<FlowEvent>("voice-flow", ({ state, message }) => {
        Voice.flow = FLOW_STATUS[state] ? state : "";
        if (!Voice.flow) api.avatar.level(0);
        hooks.line();
        if (state === "error") hooks.error(message);
      });
    } else if (!on && off) {
      off();
      off = null;
      Voice.flow = "";
      api.avatar.level(0);
      hooks.line();
    }
  };
  sync();
  const offSettings = api.listen("settings-changed", () => void api.timeout(sync, 0));
  return () => {
    offSettings();
    off?.();
    off = null;
    Voice.flow = "";
  };
}
