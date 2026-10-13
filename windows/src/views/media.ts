// The Mídia panel: what Windows saved (prints, game bar clips) and what came onto
// the island, as a grid, newest first. Nothing runs until the panel is on screen
// or Rust says the list changed; every action is a click, and "Remover da lista"
// never touches the file.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent, type MediaItem } from "../core/bridge";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

/** Thumbnails already drawn, by path and size: the grid redraws on every change. */
const thumbs = new Map<string, string>();
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

export function buildMedia(actions: ViewActions): ViewHost {
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
  main.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".media-menu, .media-more")) closeMenu();
  });

  document.addEventListener("keydown", (e) => e.key === "Escape" && menu.style.display !== "none" && closeMenu());
  // A right click anywhere outside an item (or its menu) just closes the menu.
  main.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest(".media-cell")) closeMenu();
  });

  function fail(err: unknown) {
    error = String(err).replace(/^Error:\s*/, "");
    draw();
  }

  async function load() {
    if (loading) return;
    loading = true;
    dirty = false;
    try {
      items = await Bridge.mediaList();
      error = "";
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
    loading = false;
    draw();
  }

  /** At a point in viewport coordinates (the dots button's corner, or the cursor). */
  function openMenu(item: MediaItem, x: number, y: number) {
    actions.blip();
    const run = (fn: () => Promise<void> | void) => () => {
      closeMenu();
      Promise.resolve(fn()).catch(fail);
    };
    clear(menu);
    const entry = (label: string, fn: () => Promise<void> | void) =>
      menu.append(h("button", { class: "media-menu-row", text: label, onclick: run(fn) }));
    entry("Abrir no Claude", () => actions.launchFile(item.path));
    entry("Abrir", () => Bridge.mediaOpen(item.path));
    entry("Abrir com…", () => Bridge.mediaOpenWith(item.path));
    entry("Mostrar na pasta", () => Bridge.mediaReveal(item.path));
    entry("Remover da lista", async () => {
      await Bridge.mediaRemove(item.path);
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
        const buf = await Bridge.mediaThumb(path, THUMB_PX);
        if (thumbs.size >= 300) {
          const old = thumbs.keys().next().value!;
          URL.revokeObjectURL(thumbs.get(old)!);
          thumbs.delete(old);
        }
        const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        thumbs.set(key, url);
        img.src = url;
        img.classList.add("ready");
        return;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
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
      const hit = thumbs.get(key);
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
      const more = h(
        "button",
        { class: "gh-icon media-more", title: "Ações" },
        svg(ICONS.ellipsis, 12),
      );
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
      cell.addEventListener("dblclick", () => void Bridge.mediaOpen(item.path).catch(fail));
      cells.append(cell);
      lazy.observe(img);
    }
    grid.append(cells);
  }

  // Rust says when the list changed; the panel only listens while it is the view.
  void onEvent("media-changed", () => {
    dirty = true;
    if (State.view === "media") void load();
  });

  return {
    el,
    sync() {
      const on = State.view === "media";
      if (on && (!wasOn || dirty)) void load();
      if (!on && wasOn) closeMenu();
      wasOn = on;
    },
  };
}
