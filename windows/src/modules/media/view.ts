// The Mídia panel: what Windows saved (prints, game bar clips) and what came onto
// the island, as a grid, newest first. Nothing runs until the panel is on screen
// or Rust says the list changed; every action is a click, and "Remover da lista"
// never touches the file.

import { h, svg, clear } from "../../views/dom";
import { MediaBridge, type MediaItem } from "./bridge";
import { Hooks } from "../../core/hooks";
import type { Disposer, IslandApi, ViewContext, ViewHost } from "../../core/moduleApi";
import { ICONS } from "./icons";

const THUMB_PX = 160;
const THUMB_JOBS = 3;

function kindLabel(kind: string): string {
  return kind === "screenshot" ? "Captura de tela" : kind === "video" ? "Gravação" : "Arquivo";
}

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString()
    ? `hoje ${time}`
    : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })} ${time}`;
}

/** What one run of the module holds. The views reach it with mediaOf(); start() arms it. */
export class MediaCtl {
  /** Thumbnails already drawn, by path and size: the grid redraws on every change. */
  readonly thumbs = new Map<string, string>();
  /** File name of a capture to flash once on the next draw. */
  fresh: string | null = null;
  private reloadFn: (() => void) | null = null;
  private closeFns = new Set<() => void>();
  private stops = new Set<Disposer>();

  constructor(readonly api: IslandApi) {}

  /** The view registers how it reloads, closes its menu and stops its work. */
  attach(reload: () => void, closeMenu: () => void, stop: Disposer) {
    this.reloadFn = reload;
    this.closeFns.add(closeMenu);
    this.stops.add(stop);
  }

  /** Mochi captured a window: show the list with that item highlighted. */
  highlight(name: string) {
    this.fresh = name;
    this.reloadFn?.(); // a no-op reload when the panel is not on screen; sync() loads on entry
  }

  start(): Disposer {
    const closeAll = () => this.closeFns.forEach((f) => f());
    // Capture phase on the document: nothing in the island can swallow the outside press.
    const outside = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".media-menu")) closeAll();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeAll();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", esc);
    window.addEventListener("blur", closeAll);
    const offList = this.api.listen<null>("media-changed", () => this.reloadFn?.());
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("blur", closeAll);
      offList();
      for (const s of this.stops) s();
      this.stops.clear();
      this.closeFns.clear();
      this.reloadFn = null;
      for (const url of this.thumbs.values()) URL.revokeObjectURL(url);
      this.thumbs.clear();
    };
  }
}

const instances = new WeakMap<IslandApi, MediaCtl>();

/** The controller of the module run `api` belongs to. */
export function mediaOf(api: IslandApi): MediaCtl {
  let c = instances.get(api);
  if (!c) instances.set(api, (c = new MediaCtl(api)));
  return c;
}

export function buildMediaView(ctl: MediaCtl, ctx: ViewContext): ViewHost {
  const api = ctx.api;
  let items: MediaItem[] = [];
  let dirty = true;
  let loading = false;
  let error = "";
  let wasOn = false;

  const sub = h("span", { class: "gh-sub" });
  const head = h("div", { class: "gh-head" }, h("div", { class: "gh-tab" }, h("b", { text: "Mídia" })), h("div", { class: "grow" }), sub);
  const grid = h("div", { class: "gh-list media-grid" });
  const menu = h("div", { class: "media-menu" });
  const main = h("div", { class: "gh-main" }, head, grid, menu);
  const side = h(
    "div",
    { class: "gh-side" },
    h("div", { class: "gh-side-who" }, h("b", { text: "Mídia" }), h("span", { text: "capturas e arquivos" })),
  );
  const el = h("div", { class: "view gh-view media-view" }, h("div", { class: "card gh-card" }, side, h("div", { class: "gh-col" }, main)));

  menu.style.display = "none";
  const closeMenu = () => (menu.style.display = "none");
  grid.addEventListener("scroll", closeMenu, { passive: true });

  function fail(err: unknown) {
    const msg = String(err).replace(/^Error:\s*/, "");
    // "missing": the file was deleted outside Coucou; Rust already dropped it, so refresh.
    if (msg === "missing") return void load();
    error = msg;
    draw();
  }

  async function load() {
    if (loading) return;
    loading = true;
    dirty = false;
    try {
      items = await MediaBridge.list();
      error = "";
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
    loading = false;
    draw();
  }

  /** At a point in viewport coordinates (the dots button's corner, or the cursor). */
  function openMenu(item: MediaItem, x: number, y: number) {
    ctx.actions.blip();
    const run = (fn: () => Promise<void> | void) => () => {
      closeMenu();
      Promise.resolve(fn()).catch(fail);
    };
    clear(menu);
    const entry = (label: string, fn: () => Promise<void> | void) =>
      menu.append(h("button", { class: "media-menu-row", text: label, onclick: run(fn) }));
    // Only with the Claude module on (it provides this hook).
    if (Hooks.has("launchFile")) entry("Abrir no Claude", async () => void (await api.call("launchFile", item.path, true)));
    entry("Abrir", () => MediaBridge.open(item.path));
    entry("Abrir com…", () => MediaBridge.openWith(item.path));
    entry("Mostrar na pasta", () => MediaBridge.reveal(item.path));
    entry("Remover da lista", async () => {
      await MediaBridge.remove(item.path);
      items = items.filter((i) => i.path !== item.path);
      draw();
    });
    const box = main.getBoundingClientRect();
    menu.style.display = "";
    // Pinned inside the panel when there is no room.
    const top = Math.max(2, Math.min(y - box.top, box.height - menu.offsetHeight - 4));
    const left = Math.max(2, Math.min(x - box.left, box.width - menu.offsetWidth - 4));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  // At most THUMB_JOBS requests in flight; one retry, then a neutral placeholder.
  const queue: (() => Promise<void>)[] = [];
  let inFlight = 0;
  function pump() {
    while (inFlight < THUMB_JOBS && queue.length) {
      inFlight++;
      void queue.shift()!().finally(() => {
        inFlight--;
        pump();
      });
    }
  }

  async function loadThumb(img: HTMLImageElement, key: string, path: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buf = await MediaBridge.thumb(path, THUMB_PX);
        if (ctl.thumbs.size >= 300) {
          const old = ctl.thumbs.keys().next().value!;
          URL.revokeObjectURL(ctl.thumbs.get(old)!);
          ctl.thumbs.delete(old);
        }
        const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        ctl.thumbs.set(key, url);
        img.src = url;
        img.classList.add("ready");
        return;
      } catch {
        if (attempt === 0) await new Promise<void>((r) => api.timeout(r, 600));
      }
    }
    img.parentElement?.classList.add("nothumb");
  }

  const lazy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazy.unobserve(e.target);
      const img = e.target as HTMLImageElement;
      const key = `${img.dataset.path}|${img.dataset.size}`;
      const hit = ctl.thumbs.get(key);
      if (hit) {
        img.src = hit;
        img.classList.add("ready");
      } else queue.push(() => loadThumb(img, key, img.dataset.path!));
    }
    pump();
  }, { root: grid, rootMargin: "80px" });

  function draw() {
    closeMenu();
    lazy.disconnect();
    queue.length = 0;
    clear(grid);
    sub.textContent = items.length ? `${items.length} ${items.length === 1 ? "item" : "itens"}` : "";
    if (error) grid.append(h("div", { class: "media-empty", text: error }));
    if (items.length === 0 && !error) {
      grid.append(h("div", { class: "media-empty", text: loading ? "Carregando…" : "Nada por aqui ainda. Capturas de tela, gravações e arquivos soltos na ilha aparecem aqui." }));
      return;
    }
    const cells = h("div", { class: "media-cells" });
    for (const item of items) {
      const img = h("img", { class: "media-thumb", alt: "", draggable: false, "data-path": item.path, "data-size": item.size });
      const more = h("button", { class: "gh-icon media-more", title: "Ações" }, svg(ICONS.ellipsis, 12));
      more.addEventListener("click", () => {
        const a = more.getBoundingClientRect();
        openMenu(item, a.right - 140, a.bottom + 2);
      });
      const cell = h(
        "div",
        { class: "media-cell", title: `${item.name}\n${kindLabel(item.kind)} · ${when(item.ts)}` },
        h("div", { class: "media-frame" }, img, svg(ICONS.photo, 22, { stroke: 1.6 }), more),
        h("span", { class: "media-name", text: item.name }),
        h("span", { class: "media-when", text: `${kindLabel(item.kind)} · ${when(item.ts)}` }),
      );
      // A double click is the plain "Abrir"; the menu has the rest.
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(item, e.clientX, e.clientY);
      });
      cell.addEventListener("dblclick", () => void MediaBridge.open(item.path).catch(fail));
      if (item.name === ctl.fresh) {
        cell.classList.add("fresh");
        ctl.fresh = null;
        grid.scrollTop = 0;
      }
      cells.append(cell);
      lazy.observe(img);
    }
    grid.append(cells);
  }

  ctl.attach(
    () => {
      dirty = true;
      if (api.island.view() === "media") void load();
    },
    closeMenu,
    () => { lazy.disconnect(); queue.length = 0; },
  );

  return {
    el,
    sync() {
      const on = api.island.view() === "media";
      if (on && (!wasOn || dirty)) void load();
      if (!on && wasOn) closeMenu();
      wasOn = on;
    },
  };
}
