// Mochi pulled out of the island and dropped on a window: that window is captured into the inbox
// and the Mídia list opens on it. The core only reports the pull (hook "mochiDrop") and the button
// (overlay.cursor's `down`); the ghost, the release and the attach live here.

import { h } from "../../views/dom";
import { wipe } from "../../core/canvas";
import { MediaBridge } from "../../core/bridge";
import type { Disposer, IslandApi } from "../../core/moduleApi";
import { Sound } from "../../core/sound";
import { State } from "../../core/state";
import { BotEngine, hexToRGB } from "../../mochi/engine";
import type { MediaCtl } from "./view";

const BOT_OVERHANG = 40;
const GHOST_W = 84;
const GHOST_H = GHOST_W + BOT_OVERHANG;
const PIN_MS = 8000;

export function armMochiDrop(api: IslandApi, ctl: MediaCtl): Disposer {
  let canvas: HTMLCanvasElement | null = null;
  const engine = new BotEngine();
  let last = 0;

  const move = () => {
    if (!canvas) return;
    canvas.style.left = `${State.mouse.x - GHOST_W / 2}px`;
    canvas.style.top = `${State.mouse.y - BOT_OVERHANG / 2 - GHOST_H / 2}px`;
  };
  const end = () => {
    canvas?.remove();
    canvas = null;
  };

  function release() {
    const over = api.island.mouseInside();
    end();
    if (over) return; // dropped back home: silent cancel
    MediaBridge.attachWindow()
      .then((file) => {
        // Not sent to Claude: it is already in the inbox and the Mídia list; the user picks the action there.
        api.avatar.emote("wink");
        Sound.play("attach");
        ctl.highlight(file.name);
        api.island.open("media", { pinMs: PIN_MS });
      })
      .catch((err) => api.island.error(err));
  }

  const off = api.provide("mochiDrop", () => {
    if (canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas = h("canvas", {
      style: `position:fixed;width:${GHOST_W}px;height:${GHOST_H}px;z-index:60;pointer-events:none;filter:drop-shadow(0 6px 14px rgba(0,0,0,.5))`,
    }) as HTMLCanvasElement;
    canvas.width = Math.round(GHOST_W * dpr);
    canvas.height = Math.round(GHOST_H * dpr);
    document.body.append(canvas);
    api.avatar.emote("surprised");
    const body = api.avatar.bodyColor();
    engine.bodyColor = body ? hexToRGB(body) : null; // inherits the island Mochi's color
    engine.setState("idle", true);
    engine.triggerEmote("surprised", 60);
    engine.particleOverhang = BOT_OVERHANG;
    Sound.play("pop");
    last = 0;
    move();
  });

  const offOverlay = api.island.overlay({
    el: h("i", { style: "display:none" }),
    active: () => {
      const on = canvas != null;
      document.getElementById("island")?.classList.toggle("ghost-on", on); // the island's own Mochi steps aside
      return on;
    },
    frame(now) {
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return false;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      engine.update(dt);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wipe(ctx);
      engine.draw(ctx, GHOST_W, GHOST_H);
      return true; // keeps the frame loop alive for the whole drag
    },
    cursor(_x, _y, down) {
      if (!canvas) return false;
      if (down) move();
      else release();
      return canvas != null; // true = holding the pointer: the island must not auto-collapse mid-drag
    },
  });

  return () => {
    off();
    offOverlay();
    end();
  };
}
