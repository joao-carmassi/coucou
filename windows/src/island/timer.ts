// Front-end-only timer: a countdown or a stopwatch. Time is always read from
// Date.now(), never counted by ticks, so a late or paused tick cannot drift it.
// The 1 s interval exists only while a timer runs AND the island is not hidden.

import { Sound } from "../core/sound";
import { State } from "../core/state";

type Kind = "countdown" | "stopwatch";
type Status = "idle" | "running" | "paused";

class TimerClock {
  kind: Kind = "countdown";
  status: Status = "idle";
  /** Called once when a countdown reaches 0 (the island shows its notice). */
  onDone: (() => void) | null = null;

  private endAt = 0; // countdown, running
  private startAt = 0; // stopwatch, running
  private base = 0; // ms: remaining (countdown) or elapsed (stopwatch) while paused
  private tickId: number | null = null;
  private doneId: number | null = null;

  get active() {
    return this.status !== "idle";
  }

  startCountdown(minutes: number) {
    this.begin("countdown");
    this.base = Math.max(1, minutes) * 60_000;
    this.endAt = Date.now() + this.base;
    this.sync();
  }

  startStopwatch() {
    this.begin("stopwatch");
    this.base = 0;
    this.startAt = Date.now();
    this.sync();
  }

  pause() {
    if (this.status !== "running") return;
    this.base = this.kind === "countdown" ? Math.max(0, this.endAt - Date.now()) : this.value();
    this.status = "paused";
    this.sync();
  }

  resume() {
    if (this.status !== "paused") return;
    if (this.kind === "countdown") this.endAt = Date.now() + this.base;
    else this.startAt = Date.now();
    this.status = "running";
    this.sync();
  }

  cancel() {
    this.status = "idle";
    this.sync();
  }

  /** Remaining (countdown) or elapsed (stopwatch) ms. */
  value(): number {
    if (this.status === "idle") return 0;
    if (this.kind === "countdown") return this.status === "running" ? Math.max(0, this.endAt - Date.now()) : this.base;
    return this.status === "running" ? this.base + Date.now() - this.startAt : this.base;
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

  /** Re-arms the timers to match status and island visibility. Call when either changes. */
  sync() {
    this.stopTimers();
    if (this.status === "running" && this.kind === "countdown") {
      // One-shot, so the end still rings (and is shown) if the island is hidden.
      this.doneId = window.setTimeout(() => this.finish(), Math.max(0, this.endAt - Date.now()));
    }
    if (this.status === "running" && State.mode !== "hidden") {
      this.tickId = window.setInterval(() => State.notify(), 1000);
    }
    State.notify();
  }

  private begin(kind: Kind) {
    this.kind = kind;
    this.status = "running";
  }

  private finish() {
    this.status = "idle";
    this.stopTimers();
    Sound.play("finish");
    State.notify();
    this.onDone?.();
  }

  private stopTimers() {
    if (this.tickId != null) window.clearInterval(this.tickId);
    if (this.doneId != null) window.clearTimeout(this.doneId);
    this.tickId = this.doneId = null;
  }
}

export const Timer = new TimerClock();
