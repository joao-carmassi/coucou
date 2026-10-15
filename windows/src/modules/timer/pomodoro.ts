// Pomodoro phase machine: pure functions, no DOM, no timers.

export type PomoPhase = "work" | "short" | "long";
export interface PomoCfg { work: number; short: number; long: number; every: number }
/** `cycle` is the 1-based work cycle inside the current round of `every`. */
export interface PomoState { phase: PomoPhase; cycle: number }

export const POMO_DEFAULTS: PomoCfg = { work: 25, short: 5, long: 15, every: 4 };

const int = (v: unknown, def: number, lo: number, hi: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};

/** Settings are user-editable JSON: anything out of range falls back to the default. */
export function pomoCfg(raw: unknown): PomoCfg {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    work: int(r.work, POMO_DEFAULTS.work, 1, 600), short: int(r.short, POMO_DEFAULTS.short, 1, 600),
    long: int(r.long, POMO_DEFAULTS.long, 1, 600), every: int(r.every, POMO_DEFAULTS.every, 1, 24),
  };
}

export const pomoStart = (): PomoState => ({ phase: "work", cycle: 1 });

/** The phase after this one: work -> long break on the last cycle of a round (else short); a break -> work. */
export function pomoNext(s: PomoState, cfg: PomoCfg): PomoState {
  if (s.phase === "work") return { phase: s.cycle >= cfg.every ? "long" : "short", cycle: s.cycle };
  return { phase: "work", cycle: s.phase === "long" || s.cycle >= cfg.every ? 1 : s.cycle + 1 };
}

export const pomoMinutes = (s: PomoState, cfg: PomoCfg) => cfg[s.phase];

export function pomoLabel(s: PomoState, cfg: PomoCfg): string {
  const name = s.phase === "work" ? "Foco" : s.phase === "short" ? "Pausa curta" : "Pausa longa";
  return `${name} · ciclo ${s.cycle}/${cfg.every}`;
}
