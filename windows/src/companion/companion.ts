// The companion page: one Mochi in a small transparent window, driven by the island's messages.
// Zero idle cost: no loop unless frameMode says so, no timer except the one-shot after a drag.

import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Sound } from "../core/sound";
import { wipe } from "../kit/canvas";
import { IS_TAURI, command, onEvent } from "../kit/tauri";
import type { BotEmoteName, BotStateName } from "../core/layout";
import { frameMode, IDLE_TICK_MS, type AvatarMsg } from "./policy";

const SIZE = 180; // logical px, same as the window
const OVERHANG = 40;
const DRAG_PX = 5;
const SAVE_AFTER_MOVE_MS = 400;

export function startCompanion(canvas: HTMLCanvasElement) {
  Sound.setEnabled(false); // the island plays the sounds
  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round(SIZE * dpr);
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let hidden = true; // until the first message the window stays hidden and nothing runs
  let dragging = false;
  let running = false;
  let last = 0;
  let timer = 0;

  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wipe(ctx);
    engine.draw(ctx, SIZE, SIZE);
  };

  const frame = (nowMs: number) => {
    timer = 0;
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    engine.update(dt);
    draw();
    const mode = frameMode({ hidden, active: engine.animating || engine.level > 0.001 || dragging, busy: engine.busy });
    if (mode === "raf") requestAnimationFrame(frame);
    else if (mode === "tick") timer = window.setTimeout(() => requestAnimationFrame(frame), IDLE_TICK_MS);
    else running = false;
  };

  /** Starts the loop if it is stopped (a message arrived). */
  const kick = () => {
    if (running || hidden) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };

  void onEvent<AvatarMsg>("companion-avatar", (m) => {
    if (m.color !== undefined) engine.bodyColor = m.color ? hexToRGB(m.color) : null;
    if (m.state !== undefined) engine.setState(m.state as BotStateName);
    if (m.emote) engine.triggerEmote(m.emote as BotEmoteName);
    if (m.level !== undefined) engine.setLevel(m.level, performance.now(), !!m.dance);
    if (m.hidden !== undefined && m.hidden !== hidden) {
      hidden = m.hidden;
      void command("companion_visible", { visible: !hidden });
      if (hidden) { window.clearTimeout(timer); timer = 0; running = false; }
    }
    if (!hidden) { draw(); kick(); }
  });

  // Press on Mochi: a plain click brings the island back, a pull moves the window (Windows runs the drag).
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { if (e.button === 0) down = { x: e.screenX, y: e.screenY }; });
  canvas.addEventListener("pointermove", (e) => {
    if (!down || dragging || Math.hypot(e.screenX - down.x, e.screenY - down.y) < DRAG_PX) return;
    down = null;
    dragging = true;
    kick();
    void getCurrentWindow().startDragging().finally(() => { dragging = false; kick(); });
  });
  canvas.addEventListener("pointerup", () => {
    if (down) void command("companion_click");
    down = null;
  });

  if (IS_TAURI) {
    // One save after the window stops moving; nothing runs while it stands still.
    let saveTimer = 0;
    void getCurrentWindow().onMoved(() => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void command("companion_moved"), SAVE_AFTER_MOVE_MS);
    });
    // The island may have sent its state before this page listened: ask again.
    void emitTo("island", "companion-ready", null).catch(() => {});
  }
}
