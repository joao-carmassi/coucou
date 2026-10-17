// Island side of the companion: pushes what Mochi wears to the companion window, only on change.
// While the companion is on, the island draws no Mochi of its own and runs no engine frames for him.

import { emitTo } from "@tauri-apps/api/event";
import { IS_TAURI } from "../kit/tauri";
import { levelDue, type AvatarMsg } from "../companion/policy";

export const COMPANION_LABEL = "companion";

const hex = (c: readonly number[] | null) =>
  c ? "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : null;

export class CompanionLink {
  on = false;
  private last = "";
  private lastLevel = 0;
  private levelAt = 0;

  private send(m: AvatarMsg) {
    if (IS_TAURI) void emitTo(COMPANION_LABEL, "companion-avatar", m).catch(() => {});
  }

  /** Changes the on/off state; true when it changed. */
  setOn(on: boolean): boolean {
    if (on === this.on) return false;
    this.on = on;
    this.last = "";
    this.lastLevel = 0;
    return true;
  }

  /** The state message: sent only when something in it differs from the last one. */
  state(state: string, color: readonly number[] | null, hidden: boolean) {
    if (!this.on) return;
    const m: AvatarMsg = { state, color: hex(color), hidden };
    const key = JSON.stringify(m);
    if (key === this.last) return;
    this.last = key;
    this.send(m);
  }

  /** Forgets the last message so the next `state` is sent again (the companion window just opened). */
  again() {
    this.last = "";
  }

  emote(name: string) {
    if (this.on) this.send({ emote: name });
  }

  level(v: number, dance: boolean, nowMs = performance.now()) {
    if (!this.on || !levelDue(v, this.lastLevel, nowMs - this.levelAt)) return;
    this.lastLevel = v;
    this.levelAt = nowMs;
    this.send({ level: v, dance });
  }
}
