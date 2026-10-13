// What the avatar wears: override > strongest signal > fallback. Pure, no timers.

import type { BotEmoteName, BotStateName } from "./layout";
import type { AvatarSignal } from "./moduleApi";

interface Entry { sig: AvatarSignal; at: number; seq: number }

const signals = new Map<string, Entry>();
let seq = 0;
let emote: BotEmoteName | null = null;

const same = (a: AvatarSignal, b: AvatarSignal) =>
  a.state === b.state && a.priority === b.priority && a.emote === b.emote && a.ttlMs === b.ttlMs;

export const Avatar = {
  /** True when the signal changed. Never notifies State: the caller redraws. */
  publish(owner: string, sig: AvatarSignal | null, now = performance.now()): boolean {
    const prev = signals.get(owner);
    if (!sig) return signals.delete(owner);
    signals.set(owner, { sig, at: now, seq: ++seq });
    const changed = !prev || !same(prev.sig, sig);
    if (changed && sig.emote) emote = sig.emote;
    return changed;
  },

  state(fallback: BotStateName, override: BotStateName | null, now = performance.now()): BotStateName {
    if (override) return override;
    let best: Entry | null = null;
    for (const e of signals.values()) {
      if (e.sig.ttlMs != null && now - e.at > e.sig.ttlMs) continue;
      if (!best || e.sig.priority > best.sig.priority ||
          (e.sig.priority === best.sig.priority && e.seq > best.seq)) best = e;
    }
    return best?.sig.state ?? fallback;
  },

  takeEmote(): BotEmoteName | null {
    const e = emote;
    emote = null;
    return e;
  },
};
