// The Mídia panel: what Windows saved (prints, game bar clips) and what came onto
// the island, as a grid, newest first. Nothing runs until the panel is on screen
// or Rust says the list changed; every action is a click, and "Remover da lista"
// never touches the file.

import { h, svg, clear } from "../../kit/dom";
import { paneHead, paneIcon, paneList, paneMain, paneSub, paneTab, panel } from "../../kit/panel";
import { MediaBridge, type MediaItem } from "./bridge";
import { CLAUDE_SERVICE, type LaunchFile } from "../claude/api";
import type { Disposer, IslandApi, ViewContext, ViewHost } from "../../core/moduleApi";
import { ICONS } from "./icons";
import { toolsFor } from "./tools";
import { ToolRunner } from "./toolsRun";

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
  readonly tools: ToolRunner;

  constructor(readonly api: IslandApi) { this.tools = new ToolRunner(api); }

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
      this.tools.stop();
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

  const sub = paneSub();
  const head = paneHead(paneTab(h("b", { text: "Mídia" })), h("div", { class: "grow" }), sub);
  const grid = paneList("media-grid");
  const menu = h("div", { class: "media-menu" });
  const ffbox = h("div", { class: "media-ffbox scroll" });
  ffbox.style.display = "none";
  const main = paneMain(head, grid, menu);
  const el = panel({ cls: "media-view", side: { title: "Mídia", sub: "capturas e arquivos" }, main });

  menu.style.display = "none";
  const subMenu = h("div", { class: "media-menu media-submenu" });
  subMenu.style.display = "none";
  const closeSub = () => (subMenu.style.display = "none");
  const closeMenu = () => {
    menu.style.display = "none";
    closeSub();
    document.removeEventListener("keydown", menuKeys, true);
  };
  /** Keyboard for the open menu: arrows move, Right/Enter open "Converter", Left/Esc go back one level. */
  function menuKeys(e: KeyboardEvent) {
    const subOpen = subMenu.style.display !== "none";
    const scope = subOpen && subMenu.contains(document.activeElement) ? subMenu : menu;
    const rows = [...scope.querySelectorAll<HTMLElement>(".media-menu-row")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const parent = menu.querySelector<HTMLElement>(".media-menu-sub");
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape" || e.key === "ArrowLeft") {
      // Esc with no submenu falls through to the global handler, which closes the menu.
      if (!subOpen) return;
      stop(); closeSub(); parent?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      stop();
      const d = e.key === "ArrowDown" ? 1 : -1;
      rows[at < 0 ? (d > 0 ? 0 : rows.length - 1) : (at + d + rows.length) % rows.length]?.focus();
    } else if ((e.key === "ArrowRight" || e.key === "Enter") && document.activeElement === parent) {
      stop(); openSub(true);
    }
  }
  grid.addEventListener("scroll", closeMenu, { passive: true });

  /** The opt-in ffmpeg download: shows size and source first; nothing starts until the click. */
  async function showFfmpeg() {
    ctl.tools.ffmpegWanted = false;
    let st;
    try { st = await MediaBridge.ffmpegStatus(); } catch (err) { return fail(err); }
    const hide = () => { ffbox.style.display = "none"; };
    clear(ffbox);
    ffbox.style.display = "";
    if (!ffbox.parentElement) main.insertBefore(ffbox, grid); // only in the DOM once asked for
    if (st.path) {
      ffbox.append(h("div", { text: `ffmpeg disponível: ${st.path}` }), h("button", { class: "btn secondary", text: "Ok", onclick: hide }));
      return;
    }
    const status = h("div", { class: "media-ffstatus" });
    const go = h("button", { class: "btn primary", text: `Baixar ffmpeg (${st.sizeText})` });
    const cancel = h("button", { class: "btn secondary", text: "Agora não", onclick: hide });
    go.addEventListener("click", () => {
      go.setAttribute("disabled", "");
      let id = 0;
      cancel.textContent = "Cancelar";
      cancel.onclick = () => { if (id) void MediaBridge.toolCancel(id).catch(() => {}); hide(); };
      ctl.tools.track("Baixando ffmpeg", MediaBridge.ffmpegDownload, (e) => {
        status.textContent = e.state === "progress" ? `Baixando… ${e.pct}%` : e.state === "done" ? "Pronto." : e.state === "error" ? (e.msg ?? "Falhou") : "Cancelado";
        if (e.state !== "progress") { go.removeAttribute("disabled"); cancel.textContent = "Fechar"; cancel.onclick = hide; }
      }).then((i) => { id = i; }).catch((err) => { status.textContent = String(err); go.removeAttribute("disabled"); });
    });
    ffbox.append(
      h("div", { text: "As ferramentas de vídeo e GIF precisam do ffmpeg, que não está no seu PATH." }),
      h("div", { class: "media-ffsmall", text: `Fonte: ${st.url}` }),
      h("div", { class: "media-ffsmall", text: `SHA-256 esperado: ${st.sha256} (conferido antes de extrair). Fica em %LOCALAPPDATA%\Coucou\tools.` }),
      status,
      h("div", { class: "media-ffrow" }, go, cancel),
    );
  }

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
    clear(subMenu);
    closeSub();
    const entry = (label: string, fn: () => Promise<void> | void, into: HTMLElement = menu) =>
      into.append(h("button", { class: "media-menu-row", text: label, onclick: run(fn) }));
    // Only with the Claude module on (it provides this hook).
    const launch = api.use<LaunchFile>(CLAUDE_SERVICE.launchFile);
    if (launch) entry("Abrir no Claude", async () => void (await launch(item.path, true)));
    const tools = toolsFor(item.path);
    for (const t of tools) if (t.group !== "convert") entry(t.label, () => ctl.tools.run(t, item.path));
    for (const t of tools) if (t.group === "convert") entry(t.label, () => ctl.tools.run(t, item.path), subMenu);
    if (subMenu.childElementCount) {
      const row = h("button", { class: "media-menu-row media-menu-sub", text: "Converter ▸", onclick: () => openSub(true) });
      row.setAttribute("aria-haspopup", "menu");
      row.addEventListener("mouseenter", () => openSub(false));
      menu.append(row);
    }
    entry("Abrir", () => MediaBridge.open(item.path));
    entry("Abrir com…", () => MediaBridge.openWith(item.path));
    entry("Mostrar na pasta", () => MediaBridge.reveal(item.path));
    entry("Remover da lista", async () => {
      await MediaBridge.remove(item.path);
      items = items.filter((i) => i.path !== item.path);
      draw();
    });
    // Hovering any other top row closes the submenu.
    for (const r of menu.querySelectorAll<HTMLElement>(".media-menu-row:not(.media-menu-sub)")) r.addEventListener("mouseenter", closeSub);
    if (!subMenu.parentElement) main.append(subMenu);
    const box = main.getBoundingClientRect();
    menu.style.maxHeight = `${Math.max(120, box.height - 8)}px`; // scrolls only if the panel is truly too short
    menu.style.display = "";
    // Pinned inside the panel when there is no room.
    const top = Math.max(2, Math.min(y - box.top, box.height - menu.offsetHeight - 4));
    const left = Math.max(2, Math.min(x - box.left, box.width - menu.offsetWidth - 4));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    document.removeEventListener("keydown", menuKeys, true);
    document.addEventListener("keydown", menuKeys, true);
  }

  /** Beside the "Converter" row; flips left near the right edge, shifts up near the bottom. */
  function openSub(focus: boolean) {
    const row = menu.querySelector<HTMLElement>(".media-menu-sub");
    if (!row) return;
    const box = main.getBoundingClientRect();
    subMenu.style.maxHeight = `${Math.max(120, box.height - 8)}px`;
    subMenu.style.display = "";
    const ml = parseFloat(menu.style.left) || 0;
    const mt = parseFloat(menu.style.top) || 0;
    const right = ml + menu.offsetWidth - 2;
    const left = right + subMenu.offsetWidth <= box.width - 2 ? right : Math.max(2, ml - subMenu.offsetWidth + 2);
    const top = Math.max(2, Math.min(mt + row.offsetTop - menu.scrollTop, box.height - subMenu.offsetHeight - 4));
    subMenu.style.left = `${left}px`;
    subMenu.style.top = `${top}px`;
    if (focus) subMenu.querySelector<HTMLElement>(".media-menu-row")?.focus();
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
      const more = paneIcon({ class: "media-more", title: "Ações" }, svg(ICONS.ellipsis, 12));
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
      cell.addEventListener("dblclick", () => { void MediaBridge.open(item.path).catch(fail); });
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

  // sync() only runs while the view is shown, so leaving it is noticed here.
  api.island.onChange(() => {
    if (!wasOn || api.island.view() === "media") return;
    wasOn = false;
    closeMenu();
  });

  return {
    el,
    sync() {
      const on = api.island.view() === "media";
      if (on && ctl.tools.ffmpegWanted) void showFfmpeg();
      if (on && (!wasOn || dirty)) void load();
      wasOn = on;
    },
  };
}
