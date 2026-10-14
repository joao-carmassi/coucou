// The Upload module: a file dragged onto the island, Mochi eating it, and the "open in Claude Code"
// card. The choreography (sequence.ts) and its canvas (canvas.ts) are pure drawing; this file is
// the flow that used to live in the island (file-drag events, abandon grace, progress ticks).
// The core only sees an Overlay and three views; the file goes to Claude through the launchFile hook.

import { App } from "../../kit/app";
import "./upload.css";
import { EXPANDED_W, type Disposer, type IslandApi, type ModuleDef, type Overlay } from "../../core/moduleApi";
import type { FsmState } from "../../island/fsm";
import { UploadCanvas } from "./canvas";
import { USC, UploadSeq } from "./sequence";
import { Up } from "./state";
import { ask, buildChoose, buildUpload, buildUploading } from "./view";

/** The views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<string> = new Set(["upload", "uploading", "choose"]);
/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;
/** A drop that raced the end of the drag still wins within this grace. */
const ABANDON_MS = 250;

interface DragPayload { type: "enter" | "over" | "drop" | "leave" | "end"; paths?: string[] }

/** Cancel on the drop card. The file goes with it, so the next flow doesn't carry it. */
function cancelDrop(api: IslandApi) {
  Up.droppedFile = null;
  api.island.setView(api.island.home());
}

function start(api: IslandApi): Disposer {
  let origin: { state: FsmState; view: string } | null = null;
  let abandonTimer: Disposer | null = null;
  let tens = 0;
  let done = false;

  const canvas = new UploadCanvas({ ask: () => ask(api), cancel: () => cancelDrop(api) });
  const isOn = () => api.island.mode() === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(api.island.view());
  const byId = (id: string) => document.getElementById(id);

  let wasOn = false, fadeUntil = 0;
  const overlay: Overlay = {
    el: canvas.el,
    // Called once per frame by the island: also where the ordinary views step aside and the island's own Mochi hides.
    active() {
      const on = isOn();
      const t = performance.now();
      if (on) fadeUntil = 0; else if (wasOn) fadeUntil = t + 220;
      wasOn = on;
      canvas.el.classList.toggle("on", on);
      byId("island")?.classList.toggle("upload-on", on);
      byId("views")?.classList.toggle("hidden-by-upload", on);
      byId("content")?.classList.toggle("upload-active", on);
      return on || t < fadeUntil; // the layer stays 220 ms so the fade-out shows
    },
    frame(nowMs) {
      if (!isOn()) return performance.now() < fadeUntil; // fading out: keep the last frame, no redraw
      const f = UploadSeq.frame();
      Up.progress = f.progress;
      stepSequence();
      canvas.draw(f, nowMs / 1000);
      return true;
    },
    cursor(x, y) {
      // Windows sends no cursor position with an OLE drag: the Win32 cursor poll feeds the sequence.
      if (UploadSeq.isActive && !UploadSeq.dropped) UploadSeq.updateCursor(x, y);
    },
    place(w) { canvas.el.style.left = `${(w - EXPANDED_W) / 2}px`; },
    leaving(next) { if (UploadSeq.isActive && !UPLOAD_VIEWS.has(next)) UploadSeq.deactivate(); },
  };

  /** A tick every 10 %, the chime when the bar completes, then `choose` once Mochi has grown back. */
  function stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / Up.duration));
    const t = Math.floor(p * 10);
    if (t > tens && t < 10) { tens = t; api.sound.play("tick"); }
    if (!done && since >= PRE_PROGRESS + Up.duration) {
      done = true;
      api.sound.play("approve");
      api.avatar.emote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + Up.duration + 1 && api.island.view() === "uploading") {
      api.island.setView("choose");
    }
  }

  const cancelAbandon = () => { abandonTimer?.(); abandonTimer = null; };
  const scheduleAbandon = () => {
    cancelAbandon();
    abandonTimer = api.timeout(() => { abandonTimer = null; abandonDrag(); }, ABANDON_MS);
  };

  /** The file went elsewhere: back to where the island was before the drag. */
  function abandonDrag() {
    const o = origin;
    origin = null;
    if (!o || Up.dragOver || UploadSeq.dropped) return;
    // The user moved on to something else in the meantime: leave it alone.
    if (api.island.mode() !== "expanded" || api.island.view() !== "upload") return;
    void App.log(`drag abandoned, back to ${o.state}/${o.view}`);
    UploadSeq.deactivate();
    if (o.state === "hidden") {
      // Still under the cursor (an Escape over the island): stay reachable.
      if (api.island.mouseInside()) api.island.close(); else api.island.hide();
    } else if (o.state === "home") api.island.setView(o.view);
    else api.island.close();
    api.island.redraw();
  }

  /**
   * Mochi eats the file. Nothing waits on the file system: the copy into the inbox runs in the
   * background and swaps the path in when it lands, so a slow disk never stalls the animation.
   */
  function swallow(path: string) {
    Up.droppedFile = { name: path.split(/[\\/]/).pop() || "file", path };
    Up.ingested = false;
    tens = 0;
    done = false;
    api.avatar.gulp();
    api.sound.play("approve");
    api.avatar.emote("happy");
    api.avatar.morph(0);
    Up.progress = 0;
    api.island.setView("uploading");
    // setView on a closed island goes through forceHome, which stops the sequence;
    // without a restart nothing advances past "0 %" or reaches `choose`.
    if (!UploadSeq.isActive) {
      void App.log("drop: sequence was not running, restarted");
      UploadSeq.enterZone(api.island.mouseLocal().x, api.island.mouseLocal().y);
    }
    UploadSeq.performDrop(Up.duration);
    api.island.redraw();
    Up.ingest = App.inboxIngest(path);
    Up.ingest
      .then((file) => { Up.droppedFile = { name: file.name, path: file.path }; Up.ingested = true; api.island.redraw(); })
      .catch((err) => { UploadSeq.deactivate(); api.avatar.morph(0); api.island.error(err); });
  }

  function onDrag(e: DragPayload) {
    if (e.type !== "over") void App.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (api.paused()) return;
    switch (e.type) {
      case "enter":
      case "over":
        if (Up.dragOver) return;
        cancelAbandon();
        origin ??= { state: api.island.fsmState(), view: api.island.view() };
        Up.dragOver = true;
        api.avatar.morph(1);
        api.island.open("upload");
        // After open, not before: opening an island that is hidden or folded goes through
        // forceHome, which stops a running sequence; the drop then sat on "0 %" forever.
        UploadSeq.enterZone(api.island.mouseLocal().x, api.island.mouseLocal().y);
        api.island.redraw();
        break;
      case "leave":
        if (!Up.dragOver) return;
        // The island stays open while the drag session is alive; "end" ends it.
        Up.dragOver = false;
        api.avatar.morph(0);
        UploadSeq.exitZone();
        api.island.redraw();
        break;
      case "end":
        Up.dragOver = false;
        api.avatar.morph(0);
        scheduleAbandon();
        break;
      case "drop": {
        cancelAbandon();
        origin = null;
        Up.dragOver = false;
        const path = e.paths?.[0];
        if (!path) { api.avatar.morph(0); api.island.setView(api.island.home()); return; }
        swallow(path);
        break;
      }
    }
  }

  const offDrag = api.listen<DragPayload>("file-drag", onDrag);
  const offOverlay = api.island.overlay(overlay);
  // Under the header, like on macOS: the island appends overlays on top of everything.
  byId("island-clip")?.insertBefore(canvas.el, byId("content"));
  const offVis = api.onVisibility((mode) => { if (mode !== "expanded") UploadSeq.deactivate(); });
  return () => {
    cancelAbandon();
    offDrag(); offOverlay(); offVis();
    UploadSeq.deactivate();
    for (const [id, c] of [["island", "upload-on"], ["views", "hidden-by-upload"], ["content", "upload-active"]]) byId(id)?.classList.remove(c);
    Object.assign(Up, { dragOver: false, droppedFile: null, progress: 0, ingested: false });
  };
}

export const uploadModule: ModuleDef = {
  id: "upload",
  views: [
    { name: "upload", layout: { height: 176, botX: 140, botY: 104, botDiameter: 62 }, build: () => buildUpload() },
    // botY 103 = bar top (42 + 58) + 3, so the dot rides the bar.
    { name: "uploading", layout: { height: 176, botX: 46, botY: 103, botDiameter: 20, botTrack: { from: 36, span: 526 }, glow: false }, build: () => buildUploading() },
    { name: "choose", layout: { height: 176, botX: 60, botY: 101, botDiameter: 52 }, build: (ctx) => buildChoose(ctx, () => cancelDrop(ctx.api)) },
  ],
  start,
};
