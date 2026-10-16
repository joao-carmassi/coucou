// Pure helpers: formatting and the alert rules. No DOM, no Tauri (Node tests load this file).

export interface Show { cpu: boolean; ram: boolean; gpu: boolean; disk: boolean; net: boolean; temp: boolean; top: boolean }
export const SHOW_DEFAULT: Show = { cpu: true, ram: true, gpu: true, disk: true, net: true, temp: true, top: true };

export function showOf(v: unknown): Show {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out = { ...SHOW_DEFAULT };
  for (const k of Object.keys(out) as (keyof Show)[]) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  return out;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1).replace(".", ",")} ${u[i]}`;
}

export const rate = (n: number | null): string => (n == null ? "–" : `${bytes(n)}/s`);
export const pct = (n: number | null): string => (n == null ? "–" : `${Math.round(n)}%`);

export function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

export type AlertKey = "cpu" | "ram" | "disk" | "temp";
export interface Limits { cpu: number; ram: number; disk: number; temp: number }
export const LABEL: Record<AlertKey, string> = { cpu: "CPU", ram: "Memória", disk: "Disco", temp: "Temperatura" };

/** A reading must stay over its limit for SUSTAIN checks in a row, then stays quiet for COOLDOWN checks. */
export const SUSTAIN = 2;
export const COOLDOWN = 40; // 40 x 15 s = 10 min

export class AlertState {
  private over: Partial<Record<AlertKey, number>> = {};
  private quiet: Partial<Record<AlertKey, number>> = {};

  /** Keys that should raise a notice now. null resets that key's streak; undefined (not measured this round) keeps it. */
  step(read: Partial<Record<AlertKey, number | null>>, lim: Limits): AlertKey[] {
    const fire: AlertKey[] = [];
    for (const k of ["cpu", "ram", "disk", "temp"] as AlertKey[]) {
      const q = this.quiet[k] ?? 0;
      if (q > 0) this.quiet[k] = q - 1;
      const v = read[k];
      if (v === undefined) continue;
      if (v === null || v < lim[k]) { this.over[k] = 0; continue; }
      const n = (this.over[k] ?? 0) + 1;
      this.over[k] = n;
      if (n >= SUSTAIN && (this.quiet[k] ?? 0) === 0) { fire.push(k); this.quiet[k] = COOLDOWN; }
    }
    return fire;
  }
}
