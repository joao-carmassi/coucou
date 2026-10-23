import { h, svg } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { NowPlayingBridge as Bridge, type Control } from "./bridge";
import { ICONS } from "./icons";
import { clock, fitHeight, fraction, positionAt, shapeBands, trackKey } from "./logic";
import { NP } from "./store";
import { pinButton } from "../../kit/pin";

const BARS = 16;

/** The Tocando agora tab: cover (its colours wash the card), source, title, artist, album and the spectrum; under them the
 *  controls and, when the length is known, the progress on the same row. */
export function buildView(ctx: ViewContext): ViewHost {
  const { api } = ctx;
  const fail = (e: unknown) => api.island.error(e);
  const control = (a: Control) => () => void Bridge.control(a).catch(fail);
  const iconBtn = (name: keyof typeof ICONS, label: string, onClick: () => void, cls = "np-btn") =>
    h("button", { type: "button", class: cls, "aria-label": label, title: label, onclick: onClick }, svg(ICONS[name], 18));

  // The cover drawn into a few pixels once per cover and stretched over the card: a soft wash of its colours, no filter, no per-frame cost.
  const wash = h("canvas", { class: "np-wash", width: 4, height: 3, "aria-hidden": "true" });
  const art = h("div", { class: "np-art" });
  const src = h("div", { class: "np-src" });
  const title = h("div", { class: "title np-title" });
  const artist = h("div", { class: "np-artist" });
  const album = h("div", { class: "np-album" });
  const bars = Array.from({ length: BARS }, () => h("i"));
  const eq = h("div", { class: "np-eq", "aria-hidden": "true" }, ...bars);
  const fill = h("i");
  const cur = h("span", { class: "np-time" });
  const total = h("span", { class: "np-time" });
  const progress = h("div", { class: "np-progress" }, cur, h("div", { class: "np-bar" }, fill), total);
  const prev = iconBtn("prev", "Faixa anterior", control("prev"));
  const next = iconBtn("next", "Próxima faixa", control("next"));
  const toggle = iconBtn("play", "Tocar", control("toggle"), "np-btn np-play");
  const player = h("div", { class: "np-player" },
    h("div", { class: "np-main" }, art, h("div", { class: "np-meta" }, src, title, artist, album), eq),
    h("div", { class: "np-deck" }, h("div", { class: "np-ctl" }, prev, toggle, next), progress));
  const empty = h("div", { class: "np-main np-empty" },
    h("div", { class: "np-art np-ghost" }, svg(ICONS.note, 26)),
    h("div", { class: "np-meta" },
      h("div", { class: "title np-title", text: "Nada tocando agora" }),
      h("div", { class: "np-hint", text: "Toque algo no Spotify, no navegador ou em outro player." })));
  const pin = pinButton(api, "track");
  const body = h("div", { class: "stack np-body" }, empty, player);
  body.style.padding = "14px 48px 14px 84px"; // room for the Mochi on the left (botX 54) and the pin on the right
  const box = card({ cls: "np-card" }, wash, body, pin.el);
  const el = view(box); // the pin is a sibling of the scrolling body: it never scrolls or sits under the scrollbar

  const visible = () => api.island.view() === "nowplaying";
  const paintProgress = () => {
    const t = NP.track;
    if (!t || !visible()) return;
    const f = fraction(t, Date.now());
    progress.hidden = f === null; // browsers often give no length: the controls keep the row, so the height stays
    if (f === null) return;
    fill.style.transform = `scaleX(${Math.max(0.015, f)})`; // a transform: no layout while it moves
    cur.textContent = clock(positionAt(t, Date.now()) ?? 0);
    total.textContent = clock(t.durationMs ?? 0);
  };
  const paintBars = () => {
    if (!visible()) return;
    const v = shapeBands(NP.bands, NP.sens);
    bars.forEach((b, i) => { b.style.transform = `scaleY(${(0.08 + (v[i] ?? 0) * 0.92).toFixed(2)})`; });
  };
  NP.paintProgress = paintProgress;
  NP.paintBars = paintBars;

  const paintWash = (img: HTMLImageElement) => {
    const g = wash.getContext("2d");
    if (!g) return;
    g.imageSmoothingQuality = "high";
    g.clearRect(0, 0, wash.width, wash.height);
    g.drawImage(img, 0, 0, wash.width, wash.height);
    box.classList.add("np-lit");
  };
  let key = "";
  let cover: string | null | undefined; // the art on show: a new <img> only when it changes (not on play/pause)
  const draw = (t: NonNullable<typeof NP.track>) => {
    src.textContent = t.playing ? t.app : `${t.app} · pausado`;
    title.textContent = t.title || t.app;
    artist.textContent = t.artist;
    album.textContent = t.album;
    if (t.art !== cover) {
      cover = t.art;
      box.classList.remove("np-lit");
      art.replaceChildren(t.art ? h("img", { src: t.art, alt: "", onload: (e: Event) => paintWash(e.target as HTMLImageElement) }) : svg(ICONS.note, 26));
    }
    prev.disabled = !t.canPrev;
    next.disabled = !t.canNext;
    toggle.disabled = !t.canToggle;
    const label = t.playing ? "Pausar" : "Tocar";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.replaceChildren(svg(t.playing ? ICONS.pause : ICONS.play, 16));
    box.classList.toggle("np-paused", !t.playing);
  };
  return {
    el,
    get height() { return fitHeight(!!NP.track); },
    sync() {
      if (!visible()) return;
      pin.sync();
      const t = NP.track;
      empty.hidden = !!t;
      player.hidden = !t;
      if (!t) return;
      const k = trackKey(t) + t.playing + t.canPrev + t.canNext + t.canToggle + (t.art ? 1 : 0);
      if (k !== key) { key = k; draw(t); }
      paintProgress();
      paintBars();
    },
  };
}
