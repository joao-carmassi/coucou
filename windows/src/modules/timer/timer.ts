// Timer state machine: a countdown or a stopwatch. No DOM, no timers: time is read from
// the injected clock, never counted by ticks, so a late or paused tick cannot drift it.

export type Kind = "countdown" | "stopwatch";
export type Status = "idle" | "ready" | "running" | "paused";

export class TimerClock {
  kind: Kind = "countdown";
  status: Status = "idle";
  /** Countdown length in ms (the progress bar's whole). */
  total = 0;
  /** Called after every state change (the module re-arms its timers). */
  onChange: (() => void) | null = null;
  private endAt = 0; // countdown, running
  private startAt = 0; // stopwatch, running
  private base = 0; // ms: remaining (countdown) or elapsed (stopwatch) while paused

  private now: () => number;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Running or paused; "ready" (time chosen, not started) is not active. */
  get active() {
    return this.status === "running" || this.status === "paused";
  }

  /** Picks the time and shows it without starting. */
  prepare(kind: Kind, minutes = 0) {
    this.kind = kind;
    this.status = "ready";
    this.total = kind === "countdown" ? Math.max(1, minutes) * 60_000 : 0;
    this.base = this.total;
    this.onChange?.();
  }

  start() {
    if (this.status === "ready") this.run();
  }

  resume() {
    if (this.status === "paused") this.run();
  }

  private run() {
    if (this.kind === "countdown") this.endAt = this.now() + this.base;
    else this.startAt = this.now();
    this.status = "running";
    this.onChange?.();
  }

  pause() {
    if (this.status !== "running") return;
    this.base = this.value(); // remaining (countdown) / elapsed (stopwatch)
    this.status = "paused";
    this.onChange?.();
  }

  cancel() {
    this.status = "idle";
    this.onChange?.();
  }

  /** Drops everything without notifying (module stop). */
  reset() {
    this.status = "idle";
    this.onChange = null;
  }

  /** Ms left until a running countdown ends. */
  remaining() {
    return Math.max(0, this.endAt - this.now());
  }

  /** Remaining (countdown) or elapsed (stopwatch) ms. */
  value(): number {
    if (this.status === "idle") return 0;
    if (this.kind === "countdown") return this.status === "running" ? this.remaining() : this.base;
    return this.status === "running" ? this.base + this.now() - this.startAt : this.base;
  }

  /** 0..1: countdown time left; stopwatch minute turning. */
  fraction(): number {
    const ms = this.value();
    return this.kind === "countdown" ? Math.min(1, ms / (this.total || 1)) : (ms % 60_000) / 60_000;
  }

  /** Fixed-width `mm:ss` / `h:mm:ss`; "" when no timer. */
  text(): string {
    if (this.status === "idle") return "";
    const ms = this.value();
    const s = this.kind === "countdown" ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(s / 3600);
    return h > 0 ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
  }
}
