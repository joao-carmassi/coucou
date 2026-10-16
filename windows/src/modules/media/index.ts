// The Mídia module: screenshots, recordings and dropped files, plus Mochi dropped on a window.
// Its Rust half (modules/media) watches the Windows folders and keeps the list.

import { svg } from "../../kit/dom";
import "./media.css";
import { PANEL_H } from "../../core/moduleApi";
import type { ModuleDef } from "../../core/moduleApi";
import { armMochiDrop } from "./ghost";
import { ICONS } from "./icons";
import { buildMediaView, mediaOf } from "./view";
import { UPLOAD_SERVICE } from "../upload/api";
import { dropActions } from "./tools";

export const media: ModuleDef = {
  id: "media",
  views: [{
    name: "media",
    layout: { height: PANEL_H, botX: 67, botY: 108, botDiameter: 71 },
    build: (ctx) => buildMediaView(mediaOf(ctx.api), ctx),
  }],
  tabs: [{ view: "media", title: "Mídia", icon: () => svg(ICONS.photo, 13, { stroke: 1.6 }), order: 40 }],
  start(api) {
    const ctl = mediaOf(api);
    const stopCtl = ctl.start();
    const stopDrop = armMochiDrop(api, ctl);
    // The file-drop card (upload) lists these as chips by extension; upload never imports media.
    const offActions = dropActions((t, path) => ctl.tools.run(t, path)).map((a) => api.provide(UPLOAD_SERVICE.dropAction, a));
    const offCancel = api.actions.add({
      id: "cancel-tool",
      title: "Cancelar ferramenta de mídia em andamento",
      keywords: ["converter", "gif", "ffmpeg", "ocr"],
      when: () => ctl.tools.busy,
      run: () => ctl.tools.cancelAll(),
    });
    return () => { offCancel(); offActions.forEach((o) => o()); stopDrop(); stopCtl(); };
  },
};
