export type ClockFormat = "24h" | "12h";

/** `clockFormat` is stored flat in settings.json (module id prefix); anything but "12h" is 24h. */
export const formatOf = (s: object): ClockFormat => ((s as { clockFormat?: string }).clockFormat === "12h" ? "12h" : "24h");

export function timeText(d: Date, fmt: ClockFormat, seconds = true): string {
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hour12: fmt === "12h" });
}
