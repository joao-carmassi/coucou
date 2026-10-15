// Hub — core preferences (sound, intervals, screen, autostart), module switches and presets, backup,
// and the section of each module that is on. Sidebar + search; first run shows the onboarding.

import "./settings.css";
import { Bridge, onEvent } from "../core/bridge";
import { resolveEnabled, type ModuleInfo, type SettingsSection } from "../core/moduleApi";
import { moduleSettings } from "../core/moduleSettings";
import { DEFAULT_SETTINGS, State, type Settings } from "../core/state";
import { h, clear } from "../kit/dom";
import { makeSettingsUi } from "./ui";
import { PRESETS, diffImport, matchSections, presetModules } from "./hub";

let settings: Settings = { ...DEFAULT_SETTINGS };
// ModuleSettings reads State.settings (this same object) and saves patches of its own keys.
State.settings = settings;
const put = (s: Settings) => {
  settings = s;
  State.settings = s;
};
let version = "";

const root = document.getElementById("settings-root")!;

/** Only the core's own fields: module keys are saved by their sections as patches, and a stale copy here must not undo them. */
async function save() {
  const { soundEnabled, soundVolume, autoCloseInterval, compactHideInterval, focusHoldMinutes, screen, hideWhenBusy, autostart, modulesEnabled, mochiColors, mochiSleepMinutes, paletteHotkey } = settings;
  await Bridge.saveSettings({ soundEnabled, soundVolume, autoCloseInterval, compactHideInterval, focusHoldMinutes, screen, hideWhenBusy, autostart, modulesEnabled, mochiColors, mochiSleepMinutes, paletteHotkey });
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** Per-Mochi body colours: "main" plus free-text keys (pill id or "prefix*"), each a #rrggbb picker. */
function colorsRows(): HTMLElement {
  const box = h("div", {});
  const pending = new Set<string>();
  const render = () => {
    const map = settings.mochiColors ?? {};
    const rows = ["main", ...new Set([...Object.keys(map), ...pending])].filter((k, i, a) => k !== "main" || i === 0 || a.indexOf(k) === i).map((k) => {
      const pick = h("input", { type: "color", value: map[k] ?? "#ededef" }) as HTMLInputElement;
      pick.addEventListener("change", () => {
        if (!/^#[0-9a-f]{6}$/i.test(pick.value)) return;
        settings.mochiColors = { ...settings.mochiColors, [k]: pick.value };
        pending.delete(k);
        void save();
      });
      const row = h("div", { class: "row" }, h("label", { text: k === "main" ? "Mochi principal" : k }), pick);
      const clear = h("button", { text: "Padrão" });
      clear.addEventListener("click", () => {
        const rest = { ...settings.mochiColors };
        delete rest[k];
        pending.delete(k);
        settings.mochiColors = rest;
        void save();
        render();
      });
      row.append(clear);
      return row;
    });
    const key = h("input", { type: "text", placeholder: "id da pílula ou prefixo*", style: "width:180px" }) as HTMLInputElement;
    const add = h("button", { text: "Adicionar cor" });
    add.addEventListener("click", () => {
      const k = key.value.trim();
      if (!k || k.length > 64) return;
      pending.add(k); // saved once its picker changes
      render();
    });
    box.replaceChildren(...rows, h("div", { class: "row" }, key, add));
  };
  render();
  return box;
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  let lastHide = settings.compactHideInterval > 0 ? settings.compactHideInterval : 60;
  const hide = h("input", {
    type: "number", min: "10", max: "600", step: "1",
    value: String(Math.round(lastHide)),
    style: "width:72px",
  }) as HTMLInputElement;
  hide.disabled = settings.compactHideInterval <= 0;
  hide.addEventListener("change", () => {
    lastHide = Math.max(10, Math.min(600, Number(hide.value) || 60));
    settings.compactHideInterval = lastHide;
    hide.value = String(lastHide);
    void save();
  });
  const hideNever = toggle(settings.compactHideInterval <= 0, (v) => {
    hide.disabled = v;
    settings.compactHideInterval = v ? 0 : lastHide;
    void save();
  });

  const hold = h("input", {
    type: "number", min: "0", max: "120", step: "1",
    value: String(Math.round(settings.focusHoldMinutes ?? 1)),
    style: "width:72px",
  }) as HTMLInputElement;
  hold.addEventListener("change", () => {
    settings.focusHoldMinutes = Math.max(0, Math.min(120, Math.round(Number(hold.value)) || 0));
    hold.value = String(settings.focusHoldMinutes);
    void save();
  });

  const sleepMin = h("input", {
    type: "number", min: "0", max: "240", step: "1",
    value: String(Math.round(settings.mochiSleepMinutes ?? 10)),
    style: "width:72px",
  }) as HTMLInputElement;
  sleepMin.addEventListener("change", () => {
    settings.mochiSleepMinutes = Math.max(0, Math.min(240, Math.round(Number(sleepMin.value)) || 0));
    sleepMin.value = String(settings.mochiSleepMinutes);
    void save();
  });

  const paletteKey = h("input", { type: "text", value: settings.paletteHotkey ?? "Ctrl+Alt+K", placeholder: "Ctrl+Alt+K", style: "width:140px" }) as HTMLInputElement;
  paletteKey.addEventListener("change", () => {
    settings.paletteHotkey = paletteKey.value.trim();
    void save();
  });

  const centerBtn = h("button", { type: "button", text: "Centralizar ilha" });
  const placed = Object.keys(settings.islandPlacement ?? {}).length;
  if (placed) centerBtn.title = `${placed} tela(s) com posição própria`;
  centerBtn.addEventListener("click", () => void Bridge.centerIsland());

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Tela principal" }),
    h("option", { value: "cursor", text: "Tela sob o cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    { "data-hub": "geral", "data-title": "Geral" },
    h("h2", {}, h("span", { text: "Geral" })),
    h("div", { class: "row" },
      h("label", { text: "Som" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Fechar sozinha" }),
      autoClose,
      h("span", { class: "hint", text: "segundos depois de você sair da ilha" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Ocultar sozinha" }),
      hide,
      h("span", { class: "hint", text: "segundos minimizada, depois some · nunca" }),
      hideNever,
    ),
    h("div", { class: "row" },
      h("label", { text: "Voltar à aba" }),
      hold,
      h("span", { class: "hint", text: "minutos depois de fechar a ilha (0 = sempre no início) · tarefa em andamento volta sempre" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "A ilha fica em" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Posição da ilha" }),
      centerBtn,
      h("span", { class: "hint", text: "Alt + arrastar a ilha compacta a move" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Dormir após" }),
      sleepMin,
      h("span", { class: "hint", text: "minutos parado (0 = nunca)" }),
    ),
    colorsRows(),
    h("div", { class: "row" },
      h("label", { text: "Atalho da paleta" }),
      paletteKey,
      h("span", { class: "hint", text: "ex.: Ctrl+Alt+K · vazio = sem atalho global" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Ocultar durante tela cheia e chamadas" }),
      toggle(settings.hideWhenBusy, (v) => { settings.hideWhenBusy = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Iniciar com o Windows" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Modules section ───────────────────────────────────────────────────────────

const modulesBox = h("div", { "data-hub": "modulos", "data-title": "Módulos" });
/** The sections of the modules that are on, in catalog order: they sit between the switches and the footer. */
const sectionsBox = h("div", { style: "display:contents" });
const sections = new Map<string, { el: HTMLElement; dispose?(): void; timers: Set<number>; stop(): void }>();
// Injected by startSettings (src/boot/settings.ts): this file imports no module.
let MODULE_INFO: ModuleInfo[] = [];
let SETTINGS_SECTIONS: Record<string, SettingsSection> = {};

const stopTimers = (s: { stop(): void }) => s.stop();
window.addEventListener("unload", () => sections.forEach(stopTimers));

/** A module's section exists only while the module is on. */
function renderSections(effective: Record<string, boolean>) {
  for (const [id, make] of Object.entries(SETTINGS_SECTIONS)) {
    const on = effective[id] === true;
    const has = sections.get(id);
    if (!on && has) {
      has.el.remove();
      has.dispose?.();
      stopTimers(has);
      sections.delete(id);
    } else if (on && !has) {
      const { ui, timers, stop } = makeSettingsUi();
      const made = make(moduleSettings(id, MODULE_INFO.find((m) => m.id === id)?.settingsDefaults), ui);
      made.el.dataset.hub = `mod-${id}`;
      made.el.dataset.title = MODULE_INFO.find((m) => m.id === id)?.label ?? id;
      sections.set(id, { ...made, timers, stop });
    }
  }
  const order = MODULE_INFO.map((m) => m.id);
  sectionsBox.replaceChildren(...[...sections].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([, s]) => s.el));
}

/** `effective` comes from Rust (modules-changed); until then it is computed from the stored switches. */
function renderModules(effective: Record<string, boolean> = resolveEnabled(MODULE_INFO, settings.modulesEnabled)) {
  const row = (m: (typeof MODULE_INFO)[number]) => {
    const missing = (m.requires ?? []).find((r) => effective[r] !== true);
    const sw = toggle(effective[m.id] === true, (v) => {
      settings.modulesEnabled = { ...settings.modulesEnabled, [m.id]: v };
      void save();
      renderModules();
    });
    if (missing) {
      sw.setAttribute("disabled", "");
    }
    const need = missing ? MODULE_INFO.find((x) => x.id === missing)?.label ?? missing : "";
    return h("div", { class: "row" },
      h("label", { text: m.label }),
      sw,
      missing ? h("span", { class: "hint", text: `Requer ${need}` }) : "",
    );
  };
  const rows: HTMLElement[] = MODULE_INFO.filter((m) => !m.group).map(row);
  // Grouped modules sit under their group's heading, in catalog order.
  for (const g of [...new Set(MODULE_INFO.flatMap((m) => (m.group ? [m.group] : [])))]) {
    rows.push(h("h3", { class: "hint", text: g }), ...MODULE_INFO.filter((m) => m.group === g).map(row));
  }
  modulesBox.replaceChildren(h("section", { id: "modules" }, h("h2", {}, h("span", { text: "Módulos" })), ...rows));
  renderSections(effective);
  refreshNav();
}

// ── Presets, backup, search ───────────────────────────────────────────────────

function presetButtons(after?: () => void): HTMLElement[] {
  return PRESETS.map((p) => {
    const b = h("button", { text: p.label });
    b.addEventListener("click", () => {
      settings.modulesEnabled = { ...settings.modulesEnabled, ...presetModules(MODULE_INFO, p.id) };
      void save();
      if (after) after();
      else renderModules();
    });
    return b;
  });
}

function presetsSection(): HTMLElement {
  return h("section", { "data-hub": "presets", "data-title": "Presets" },
    h("h2", {}, h("span", { text: "Presets" })),
    h("div", { class: "hint", text: "Liga e desliga os módulos de uma vez. Você ainda pode ajustar cada um depois." }),
    h("div", { class: "row" }, ...presetButtons()),
  );
}

function backupSection(): HTMLElement {
  const out = h("div", { class: "hint" });
  const diffBox = h("div", {});
  const file = h("input", { type: "file", accept: ".json,application/json", hidden: "" }) as HTMLInputElement;

  const exportBtn = h("button", { text: "Exportar configurações" });
  exportBtn.addEventListener("click", async () => {
    const json = await Bridge.exportSettings();
    if (!json) return;
    const a = h("a", { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: "coucou-config.json" }) as HTMLAnchorElement;
    a.click();
    URL.revokeObjectURL(a.href);
    out.textContent = "Exportado. Chaves e senhas ficam de fora.";
  });

  const importBtn = h("button", { text: "Importar configurações" });
  importBtn.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    if (f.size > 1_000_000) { out.textContent = "Arquivo grande demais."; return; }
    const diff = diffImport(settings as unknown as Record<string, unknown>, await f.text());
    clear(diffBox);
    if (typeof diff === "string") { out.textContent = diff; return; }
    out.textContent = "";
    if (!diff.changes.length) { out.textContent = "Nada muda: o arquivo é igual às configurações atuais."; return; }
    const apply = h("button", { class: "primary", text: `Aplicar ${diff.changes.length} ${diff.changes.length === 1 ? "alteração" : "alterações"}` });
    apply.addEventListener("click", async () => {
      try {
        await Bridge.saveSettings(diff.patch);
      } catch (e) {
        out.textContent = `Não foi possível importar: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
      put({ ...settings, ...diff.patch } as Settings);
      clear(diffBox);
      out.textContent = "Importado.";
      renderModules();
    });
    diffBox.append(
      h("div", { class: "hint", text: "Chaves que mudam (nada é aplicado antes do clique):" }),
      h("ul", {}, ...diff.changes.map((c) => h("li", { text: `${c.key} (${c.kind})` }))),
      apply,
    );
  });

  return h("section", { "data-hub": "backup", "data-title": "Backup" },
    h("h2", {}, h("span", { text: "Backup" })),
    h("div", { class: "row" }, exportBtn, importBtn, file),
    out,
    diffBox,
  );
}

const search = h("input", { type: "text", placeholder: "Buscar nas configurações…", class: "hub-search" }) as HTMLInputElement;
const nav = h("nav", { class: "hub-nav" });
search.addEventListener("input", refreshNav);

/** Sidebar entries and search filtering come from the sections in the DOM. */
function refreshNav() {
  const els = [...root.querySelectorAll<HTMLElement>("[data-hub]")];
  const all = els.map((el) => ({ id: el.dataset.hub!, title: el.dataset.title ?? "", text: el.textContent ?? "" }));
  const hit = new Set(matchSections(search.value, all));
  els.forEach((el) => { el.hidden = !hit.has(el.dataset.hub!); });
  nav.replaceChildren(
    ...els.filter((el) => !el.hidden).map((el) => {
      const b = h("button", { class: "hub-link", text: el.dataset.title ?? "" });
      b.addEventListener("click", () => el.scrollIntoView({ behavior: "smooth", block: "start" }));
      return b;
    }),
  );
}

// ── Onboarding ────────────────────────────────────────────────────────────────

/** Three steps on first run: preset, sound and autostart, done. Writes the current version at the end. */
function onboarding(finish: () => void): HTMLElement {
  const box = h("div", { class: "onboarding" });
  const next = (to: number, text: string) => {
    const b = h("button", { text });
    b.addEventListener("click", () => step(to));
    return b;
  };
  const step = (n: number) => {
    clear(box);
    box.append(h("div", { class: "hint", text: `Passo ${n} de 3` }));
    if (n === 1) {
      box.append(
        h("h2", { text: "Escolha um ponto de partida" }),
        h("div", { class: "row" }, ...presetButtons(() => step(2))),
        next(2, "Pular"),
      );
    } else if (n === 2) {
      box.append(
        h("h2", { text: "Som e inicialização" }),
        h("div", { class: "row" }, h("label", { text: "Som" }), toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); })),
        h("div", { class: "row" }, h("label", { text: "Iniciar com o Windows" }), toggle(settings.autostart, (v) => { settings.autostart = v; void save(); })),
        next(3, "Continuar"),
      );
    } else {
      const done = h("button", { class: "primary", text: "Concluir" });
      done.addEventListener("click", async () => {
        await Bridge.saveSettings({ onboardedVersion: version || "0" });
        put({ ...settings, onboardedVersion: version || "0" });
        finish();
      });
      box.append(h("h2", { text: "Tudo pronto" }), h("div", { class: "hint", text: "Você pode mudar tudo isso depois, nas configurações." }), done);
    }
  };
  step(1);
  return h("section", {}, box);
}

function safeBanner(): HTMLElement {
  const b = h("button", { class: "primary", text: "Sair do modo seguro" });
  const bar = h("div", { class: "banner" },
    h("span", { text: "Modo seguro: o Coucou não fechou bem nas últimas inicializações e só o essencial está ligado." }),
    b,
  );
  b.addEventListener("click", async () => {
    if (await Bridge.safeModeExit()) bar.remove();
  });
  return bar;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

export function startSettings(catalog: ModuleInfo[], sectionMakers: Record<string, SettingsSection>) {
  MODULE_INFO = catalog;
  SETTINGS_SECTIONS = sectionMakers;
  void main();
}

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    put({ ...settings, ...boot.settings });
    version = boot.version;
  }

  const hub = () => {
    clear(root);
    root.append(
      h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
      ...(boot?.safeMode ? [safeBanner()] : []),
      h("div", { class: "hub" },
        h("aside", { class: "hub-side" }, search, nav),
        h("main", { class: "hub-main" },
          generalSection(),
          presetsSection(),
          modulesBox,
          sectionsBox,
          backupSection(),
          h("div", {
            class: "hint",
            text: "Sem telemetria. As requisições de rede só vão para os serviços que você mesmo configurar.",
          }),
        ),
      ),
    );
    renderModules(boot?.modules);
  };
  clear(root);
  if (settings.onboardedVersion === "") {
    // Written on first show, so a window closed without finishing does not reopen at every launch.
    void Bridge.saveSettings({ onboardedVersion: version || "0" });
    root.append(h("h1", {}, h("span", { text: "Bem-vindo ao Coucou" })), onboarding(hub));
  } else hub();

  void onEvent<Record<string, boolean>>("modules-changed", (m) => { if (root.querySelector(".hub")) renderModules(m); });

  void onEvent<Settings>("settings-changed", (s) => put({ ...settings, ...s }));

  // Scroll to the section the window was opened for, if any.
  const shown = (target: string) => {
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    // The cue sections wait for (slow checks only run while someone is looking).
    window.dispatchEvent(new Event("coucou:settings-shown"));
  };
  void onEvent<null>("settings-shown", async () => shown((await Bridge.takeSettingsSection()) ?? ""));
  const pending = (await Bridge.takeSettingsSection()) ?? "";
  if (pending) shown(pending);
}
