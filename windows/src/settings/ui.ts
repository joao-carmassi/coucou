import type { SettingsUi } from "../core/moduleApi";

/** Timers of one settings section: after stop() a late timeout call is ignored. */
export function makeSettingsUi() {
  const timers = new Set<number>();
  let disposed = false;
  const ui: SettingsUi = {
    timeout: (fn, ms) => {
      if (disposed) return;
      const t = globalThis.setTimeout(() => { timers.delete(t as unknown as number); fn(); }, ms) as unknown as number;
      timers.add(t);
    },
  };
  const stop = () => { disposed = true; timers.forEach((t) => globalThis.clearTimeout(t)); timers.clear(); };
  return { ui, timers, stop };
}
