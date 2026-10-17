import { h, svg } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { Disposer, ViewContext, ViewHost } from "../../core/moduleApi";
import { NowPlayingBridge as Bridge, type Control } from "./bridge";
import { ICONS } from "./icons";
import { clock, fraction, positionAt, shapeBands, trackKey } from "./logic";
import { NP } from "./store";
import { pinButton } from "../../kit/pin";

const BARS = 16;

/** The Tocando agora tab: cover, title, progress (when the length is known), controls, player volume and the spectrum. */
export function buildView(ctx: ViewContext): ViewHost {
  const { api } = ctx;
  const fail = (e: unknown) => api.island.error(e);
  const control = (a: Control) => () => void Bridge.control(a).catch(fail);
  const iconBtn = (name: keyof typeof ICONS, label: string, onClick: () => void) =>
    h("button", { class: "np-btn", "aria-label": label, title: label, onclick: onClick }, svg(ICONS[name], 18));

  const art = h("div", { class: "np-art" });
  const title = h("div", { class: "title np-title" });
  const artist = h("div", { class: "sub np-artist" });
  const where = h("div", { class: "np-where" });
  const bars = Array.from({ length: BARS }, () => h("i"));
  const eq = h("div", { class: "np-eq", "aria-hidden": "true" }, ...bars);
  const fill = h("i");
  const cur = h("span");
  const total = h("span");
  const progress = h("div", { class: "np-progress" }, h("div", { class: "np-bar" }, fill), h("div", { class: "np-times" }, cur, total));
  const prev = iconBtn("prev", "Faixa anterior", control("prev"));
  const next = iconBtn("next", "Próxima faixa", control("next"));
  const toggle = iconBtn("play", "Tocar ou pausar", control("toggle"));
  const vol = h("input", { class: "np-vol", type: "range", min: 0, max: 100, step: 1, "aria-label": "Volume do app", disabled: true }) as HTMLInputElement;
  const volHint = h("span", { class: "np-hint" });
  const player = h("div", { class: "np-player" },
    h("div", { class: "np-main" }, art, h("div", { class: "np-meta" }, title, artist, where), eq),
    progress,
    h("div", { class: "np-ctl" }, prev, toggle, next, h("div", { class: "grow" }), volHint, vol));
  const empty = h("div", { class: "np-empty" },
    h("div", { class: "title", text: "Nada tocando agora" }),
    h("div", { class: "sub", text: "Toque algo no Spotify, no navegador ou em outro player." }));
  const pin = pinButton(api, "track");
  const body = h("div", { class: "stack np-body" }, empty, player);
  body.style.padding = "14px 48px 14px 84px"; // room for the Mochi on the left (botX 54) and the pin on the right
  const el = view(card(null, body, pin.el)); // the pin is a sibling of the scrolling body: it never scrolls or sits under the scrollbar

  const visible = () => api.island.view() === "nowplaying";
  const paintProgress = () => {
    const t = NP.track;
    if (!t || !visible()) return;
    const f = fraction(t, Date.now());
    progress.hidden = f === null; // browsers often give no length
    if (f === null) return;
    fill.style.width = `${Math.max(1.5, f * 100)}%`;
    cur.textContent = clock(positionAt(t, Date.now()) ?? 0);
    total.textContent = clock(t.durationMs ?? 0);
  };
  const paintBars = () => {
    if (!visible()) return;
    const v = shapeBands(NP.bands, NP.sens);
    bars.forEach((b, i) => { b.style.height = `${Math.round(8 + (v[i] ?? 0) * 92)}%`; });
  };
  NP.paintProgress = paintProgress;
  NP.paintBars = paintBars;

  let key = "";
  let volFor = ""; // the player whose volume the slider shows; reset whenever the tab is left
  let sent: Disposer | null = null;
  let want = 0;
  vol.addEventListener("input", () => {
    want = Number(vol.value) / 100;
    if (sent) return; // one write per 120 ms while dragging
    sent = api.timeout(() => {
      sent = null;
      void Bridge.volumeSet(want).then((ok) => { volHint.textContent = ok ? "" : "sem volume"; }).catch(fail);
    }, 120);
  });

  const draw = (t: NonNullable<typeof NP.track>) => {
    title.textContent = t.title || t.app;
    artist.textContent = t.artist;
    where.textContent = [t.album, t.app].filter(Boolean).join(" · ");
    art.replaceChildren(t.art ? h("img", { src: t.art, alt: "" }) : svg(ICONS.note, 22));
    prev.disabled = !t.canPrev;
    next.disabled = !t.canNext;
    toggle.disabled = !t.canToggle;
    toggle.replaceChildren(svg(t.playing ? ICONS.pause : ICONS.play, 18));
  };
  return {
    el,
    sync() {
      if (!visible()) { volFor = ""; return; }
      pin.sync();
      const t = NP.track;
      empty.hidden = !!t;
      player.hidden = !t;
      if (!t) return;
      const k = trackKey(t) + t.playing + t.canPrev + t.canNext + t.canToggle + (t.art ? 1 : 0);
      if (k !== key) { key = k; draw(t); }
      if (volFor !== t.appId) {
        volFor = t.appId;
        vol.disabled = true;
        volHint.textContent = "";
        void Bridge.volumeGet().then((v) => {
          if (volFor !== t.appId) return;
          vol.disabled = v === null;
          volHint.textContent = v === null ? "sem volume" : "";
          if (v !== null) vol.value = String(Math.round(v * 100));
        }).catch(fail);
      }
      paintProgress();
      paintBars();
    },
  };
}

