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

  function openMenu(item: MediaItem, anchor: HTMLElement) {
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
    const a = anchor.getBoundingClientRect();
    menu.style.display = "";
    // Under the button, flipped up and pinned inside the panel when there is no room.
    const top = Math.max(2, Math.min(a.bottom - box.top + 2, box.height - menu.offsetHeight - 4));
    const left = Math.max(2, Math.min(a.right - box.left - menu.offsetWidth, box.width - menu.offsetWidth - 4));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  const lazy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazy.unobserve(e.target);
      const img = e.target as HTMLImageElement;
      const path = img.dataset.path!;
      const key = `${path}|${img.dataset.size}`;
      const set = (url: string) => {
        img.src = url;
        img.classList.add("ready");
      };
      const hit = thumbs.get(key);
      if (hit) return set(hit);
      Bridge.mediaThumb(path, THUMB_PX)
        .then((buf) => {
          if (thumbs.size > 300) thumbs.clear();
          const url = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
          thumbs.set(key, url);
          set(url);
        })
        .catch(() => {});
    }
  }, { root: grid, rootMargin: "80px" });

  function draw() {
    closeMenu();
    lazy.disconnect();
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
      more.addEventListener("click", () => openMenu(item, more));
      const cell = h(
        "div",
        { class: "media-cell", title: `${item.name}\n${kindLabel(item.kind)} · ${when(item.ts)}` },
        h("div", { class: "media-frame" }, img, more),
        h("span", { class: "media-name", text: item.name }),
        h("span", { class: "media-when", text: `${kindLabel(item.kind)} · ${when(item.ts)}` }),
      );
      // A double click is the plain "Abrir"; the menu has the rest.
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
