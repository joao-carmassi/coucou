// Pure helpers: formatting and the alert rules. No DOM, no Tauri (Node tests load this file).

// A stale `top` key in an older settings file is ignored.
export interface Show { cpu: boolean; ram: boolean; gpu: boolean; disk: boolean; net: boolean; temp: boolean }
export const SHOW_DEFAULT: Show = { cpu: true, ram: true, gpu: true, disk: true, net: true, temp: true };

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

/** Colour band of a temperature: hot from the alert limit, warm from 20 °C under it. */
export const heat = (c: number, max: number): "cool" | "warm" | "hot" => (c >= max ? "hot" : c >= max - 20 ? "warm" : "cool");

/** Sparkline of the last `slots` samples, right-aligned, in a 100 x 24 box (values 0..100). Empty below 2 points. */
export function spark(v: number[], slots = 30): { line: string; area: string } {
  const pts = v.slice(-slots);
  if (pts.length < 2) return { line: "", area: "" };
  const step = 100 / (slots - 1);
  const xy = pts.map((p, i) => `${(100 - (pts.length - 1 - i) * step).toFixed(2)},${(23 - (Math.max(0, Math.min(100, p)) * 22) / 100).toFixed(2)}`);
  const line = `M${xy.join("L")}`;
  return { line, area: `${line}L100,24L${xy[0].split(",")[0]},24Z` };
}

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

/** Island height for the shown sections (px of the CSS box model: tile 81, section head 26, row 16 + gap 4, chip 22, note ~80).
 *  chrome 56 = #content padding 8 + 10, header 34, card border 2, +2 slack (a 1 px overflow would show a scrollbar); pad = the body's own top and bottom padding (14 + 14).
 *  With temperatures off the island is exactly tall enough for the rest (no scroll); with them on it keeps that height and the
 *  body scrolls, unless temperatures are all there is. */
export interface Fit { drives: number; chipLines: number; note: boolean }
export const FIT_MIN = 160;
export function fitHeight(s: Show, f: Fit, chrome = 56, pad = 14, max = 320): number {
  const rest: number[] = [];
  if (s.cpu || s.ram || s.gpu) rest.push(81);
  const disk = s.disk ? 26 + Math.max(1, f.drives) * 20 - 4 : 0;
  const net = s.net ? 26 + 2 * 20 - 4 : 0;
  if (disk || net) rest.push(Math.max(disk, net));
  const parts = !s.temp || rest.length ? rest : [26 + Math.max(1, f.chipLines) * 28 - 6 + (f.note ? 90 : 0)];
  const content = parts.reduce((a, b) => a + b, 0) + 10 * Math.max(0, parts.length - 1);
  return Math.min(max, Math.max(FIT_MIN, chrome + 2 * pad + content));
}

/** The one-line source "CPU 53% · RAM 38% · GPU 36%": only what the user shows (sysmonShow) and the probe could read; null = nothing to say. */
export function usageLine(p: { cpu: number | null; ram: number | null; gpu?: number | null } | null, show: Show): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (show.cpu && p.cpu != null) parts.push(`CPU ${pct(p.cpu)}`);
  if (show.ram && p.ram != null) parts.push(`RAM ${pct(p.ram)}`);
  if (show.gpu && p.gpu != null) parts.push(`GPU ${pct(p.gpu)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** While the usage line is pinned (and the island visible) it is re-read this often. */
export const USAGE_MS = 4000;
