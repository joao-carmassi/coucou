// Island views — DOM ports of IslandViewContent.swift, core only: the empty home
// card, the greeting, note, confused and in-island settings.

import { h, svg, clear } from "../kit/dom";
import { ICONS } from "../kit/icons";
import { State } from "../core/state";
import { card } from "../kit/card";
import type { IslandViewName } from "../core/layout";
import type { TabDef, ViewHost } from "../core/moduleApi";
import { Actions, type Entry } from "../core/actions";

export type { ViewHost } from "../core/moduleApi";

export interface ViewActions {
  setView(v: IslandViewName): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

// ── Header ────────────────────────────────────────────────────────────────────

export interface Header extends ViewHost {
  setTabs(tabs: TabDef[]): void;
}

/** Tabs come from the modules (setTabs). `tabOf` maps a view to the tab view it lights. */
export function buildHeader(actions: ViewActions, tabOf: (view: string) => string | undefined): Header {
  const gearBtn = h("button", { title: "Configurações", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Silenciar", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  const tabsEl = h("div", { class: "tabs" });
  let tabs: { def: TabDef; btn: HTMLElement }[] = [];

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    tabsEl,
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    setTabs(defs) {
      tabs = defs.map((def) => {
        // The home tab goes where home is now (a pending request's card is not a place to go back to).
        const btn = h("button", { class: "tab", title: def.title, onclick: () => go(def.home ? State.defaultView() : def.view) }, def.icon());
        return { def, btn };
      });
      tabsEl.replaceChildren(...tabs.map((t) => t.btn));
    },
    sync() {
      const v = State.view;
      const own = tabOf(v);
      for (const t of tabs) t.btn.classList.toggle("on", v === t.def.view || own === t.def.view);
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      soundBtn.title = State.settings.soundEnabled ? "Silenciar" : "Ativar som";
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;justify-content:center;gap:5px" },
    h("div", { class: "title", text: "Nenhum módulo ativo" }),
    h("div", { class: "sub", text: "Nada para mostrar por aqui ainda." }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Cliques demais de uma vez." }),
    h("div", { class: "sub", text: "Me dá um segundo — volto ao trabalho em três segundos." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Som" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.dial, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Configurações…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Fechar auto · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
    },
  };
}

// ── Palette ───────────────────────────────────────────────────────────────────

export interface PaletteView extends ViewHost {
  /** Empties the query and the selection (on open). */
  reset(): void;
  move(delta: number): void;
  current(): Entry | null;
}

const MAX_MATCHES = 6;

/** The input and its matches; the island's key handler drives arrows/Enter/Esc, the view only draws and takes typing and clicks. */
function buildPalette(actions: ViewActions, pick: (e: Entry) => void): PaletteView {
  const input = h("input", { class: "island-field", type: "text", placeholder: "Digite um comando…", autocomplete: "off", spellcheck: false, "data-palette": true }) as HTMLInputElement;
  const list = h("div", { class: "settings-rows" });
  let at = 0;
  let shown: Entry[] = [];
  let sig = "";

  const entries = (): Entry[] => {
    const tabs: Entry[] = State.tabs.map((t) => ({ key: `#tab.${t.view}`, title: `Ir para ${t.title}`, run: () => actions.setView(t.home ? State.defaultView() : t.view) }));
    return Actions.search(input.value, tabs).slice(0, MAX_MATCHES);
  };
  const draw = () => {
    shown = entries();
    at = Math.min(at, Math.max(0, shown.length - 1));
    const next = `${shown.map((e) => e.key + e.title).join("|")}#${at}`;
    if (next === sig) return;
    sig = next;
    list.replaceChildren(...(shown.length
      ? shown.map((e, i) => h("button", { class: i === at ? "link-btn on" : "link-btn", style: "text-align:left;padding:4px 8px;border-radius:6px;" + (i === at ? "background:rgba(255,255,255,0.12)" : ""), text: e.title, onclick: () => pick(e) }))
      : [h("div", { class: "sub", text: "Nada encontrado." })]));
  };
  input.addEventListener("input", () => { at = 0; draw(); });

  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:6px 16px 6px 84px;gap:6px" }, input, list)));
  return {
    el,
    sync: draw,
    focus: () => input.focus(),
    reset() { input.value = ""; at = 0; sig = ""; },
    move(d) {
      if (!shown.length) return;
      at = (at + d + shown.length) % shown.length;
      draw();
    },
    current: () => shown[at] ?? null,
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** The greeting has no DOM view: the island draws it on its own canvas. */
export function buildViews(actions: ViewActions, pick: (e: Entry) => void): Map<string, ViewHost> {
  const map = new Map<string, ViewHost>();
  map.set("empty", buildEmpty());
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("palette", buildPalette(actions, pick));
  return map;
}
