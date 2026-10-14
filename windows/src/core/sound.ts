// SoundEngine — port of SoundEngine.swift.
// The 28 WAVs live in windows/sounds/ (see SOUNDS_DIR in vite.config.ts);
// they are served at /sounds/<name>.wav. Default volume 0.12, slider range 0–0.2,
// exactly like the Mac player, and several sounds may overlap.

export const SOUND_NAMES = [
  "peek", "open", "close", "hover", "blip", "slap", "annoyed", "dizzy", "greet",
  "work", "finish", "error", "alert", "ask", "approve", "gulp", "tick",
  "send", "love", "pop", "proud", "wink", "yawn", "attach", "think", "search",
  "wait", "sleep",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

class SoundEngine {
  enabled = true;
  volume = 0.12;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private idleTimer: number | null = null;
  private loaded = false;
  private extra = new Map<string, string>();

  private async load(name: string, url: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      // A module sound unregistered while it loaded must not come back.
      if (SOUND_NAMES.includes(name as never) || this.extra.has(name)) this.buffers.set(name, buf);
    } catch {
      /* a missing sound must never break the island */
    }
  }

  /** A module's own sound (a WAV url). Loaded with the rest, or at once if the engine is already up. */
  register(name: string, url: string): () => void {
    this.extra.set(name, url);
    if (this.loaded) void this.load(name, url);
    return () => { this.extra.delete(name); this.buffers.delete(name); };
  }

  /** Creates the context and decodes every WAV. Safe to call more than once. */
  preload(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.master = master;
      await Promise.all([
        ...SOUND_NAMES.map((name) => this.load(name, `/sounds/${name}.wav`)),
        ...[...this.extra].map(([name, url]) => this.load(name, url)),
      ]);
      // A sound registered while the rest was loading missed the snapshot above.
      await Promise.all([...this.extra].filter(([n]) => !this.buffers.has(n)).map(([n, u]) => this.load(n, u)));
      this.loaded = true;
      this.idle();
    })();
    return this.loading;
  }

  /** WebView2 can hand us a suspended context; call after any user input. */
  resume() {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.ctx?.resume().then(() => this.idle());
  }

  /**
   * Called when the island goes quiet. A running AudioContext keeps an audio
   * thread and its render quantum alive even with nothing playing, which shows
   * up as a steady trickle of CPU on a machine that is supposed to be idle.
   *
   * The delay covers the tail of whatever just played — suspending mid-sound
   * would clip it — and `play()` resumes the context on its own.
   */
  idle() {
    if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend();
    }, 1500);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(0.2, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) void this.preload();
    else void this.ctx?.suspend();
  }

  play(name: SoundName | string) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const master = this.master;
    const buf = this.buffers.get(name);
    if (!ctx || !master || !buf) {
      // Not loaded yet (first event after boot): load, then play once.
      if (!this.loaded) void this.preload().then(() => this.loaded && this.buffers.has(name) && this.play(name));
      return;
    }
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.onended = () => this.idle();
    src.start();
  }
}

export const Sound = new SoundEngine();
