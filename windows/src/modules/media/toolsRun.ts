// Runs media tools: one Rust worker per job, announced on the island. The `media-tool` event is
// listened to only while a job is in flight, so an idle module holds no subscription.

import type { Disposer, IslandApi } from "../../core/moduleApi";
import { MediaBridge, type ToolEvent } from "./bridge";
import { doneText, type ToolSpec } from "./tools";

const fileName = (p: string) => p.split(/[\/]/).pop() ?? p;

export class ToolRunner {
  private jobs = new Map<number, { label: string; on?: (e: ToolEvent) => void }>();
  private early: ToolEvent[] = [];
  private off: Disposer | null = null;
  /** The user asked for ffmpeg: the Mídia panel shows its download box when it opens. */
  ffmpegWanted = false;

  constructor(private api: IslandApi) {}

  get busy() { return this.jobs.size > 0; }

  cancelAll() { for (const id of this.jobs.keys()) void MediaBridge.toolCancel(id).catch(() => {}); }

  stop() { this.off?.(); this.off = null; this.jobs.clear(); this.early = []; }

  /** A drop action or menu entry for `path`. */
  async run(t: ToolSpec, path: string): Promise<void> {
    if (t.op === "info") {
      const i = await MediaBridge.toolInfo(path);
      const pages = i.pages != null ? `${i.pages} ${i.pages === 1 ? "página" : "páginas"} · ` : "";
      this.api.island.notice({ text: `${fileName(path)}: ${pages}${i.sizeText}`, ms: 6000, key: "media-info" });
      return;
    }
    try {
      await this.track(t.label, () => MediaBridge.toolRun(t.op, path, t.arg));
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, "");
      if (msg === "ffmpeg não encontrado") {
        this.ffmpegWanted = true;
        this.api.island.notice({ text: "Falta o ffmpeg. Abra Mídia para baixar.", view: "media", ms: 6000, key: "media-ffmpeg" });
      } else this.api.island.notice({ text: msg, ms: 6000, key: "media-tool-err" });
    }
  }

  /** Starts a job and follows it; resolves once it is registered (the work goes on in Rust). */
  async track(label: string, start: () => Promise<number>, on?: (e: ToolEvent) => void): Promise<number> {
    this.listen();
    const id = await start().catch((e) => { this.maybeStop(); throw e; });
    this.jobs.set(id, { label, on });
    for (const e of this.early.splice(0)) this.handle(e);
    return id;
  }

  private listen() {
    this.off ??= this.api.listen<ToolEvent>("media-tool", (e) => this.handle(e));
  }

  private maybeStop() { if (!this.jobs.size) { this.off?.(); this.off = null; } }

  private handle(e: ToolEvent) {
    const job = this.jobs.get(e.id);
    if (!job) { this.early.push(e); return; }
    job.on?.(e);
    const key = `media-tool-${e.id}`;
    const n = (x: Parameters<IslandApi["island"]["notice"]>[0]) => this.api.island.notice(x);
    if (e.state === "progress") n({ text: `${job.label} ${e.pct}%`, ms: 2500, key });
    else {
      this.jobs.delete(e.id);
      if (e.state === "done") {
        n({ text: e.op === "ffmpeg" ? "ffmpeg instalado" : doneText(e.op, e.out ? fileName(e.out) : "", e.text), ms: 7000, key, view: "media" });
        this.api.avatar.emote("happy");
      } else if (e.state === "cancelled") n({ text: `${job.label}: cancelado`, ms: 3000, key });
      else n({ text: e.msg ?? "Falhou", ms: 7000, key });
      this.maybeStop();
    }
  }
}
