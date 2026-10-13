// Settings window — core preferences only: sound, volume, close/hide intervals,
// screen, autostart. Module sections plug in later.

import "./settings.css";
import { Bridge, onEvent } from "../core/bridge";
import { resolveEnabled } from "../core/moduleApi";
import { MODULE_INFO } from "../modules/catalog";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
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
    {},
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
      h("label", { text: "A ilha fica em" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Iniciar com o Windows" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Modules section ───────────────────────────────────────────────────────────

const modulesBox = h("div", {});

/** `effective` comes from Rust (modules-changed); until then it is computed from the stored switches. */
function renderModules(effective: Record<string, boolean> = resolveEnabled(MODULE_INFO, settings.modulesEnabled)) {
  const rows = MODULE_INFO.map((m) => {
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
  });
  modulesBox.replaceChildren(h("section", { id: "modules" }, h("h2", {}, h("span", { text: "Módulos" })), ...rows));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    generalSection(),
    modulesBox,
    h("div", {
      class: "hint",
      text: "Sem telemetria. As requisições de rede só vão para os serviços que você mesmo configurar.",
    }),
  );

  renderModules(boot?.modules);
  void onEvent<Record<string, boolean>>("modules-changed", (m) => renderModules(m));

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });

  // Scroll to the section the window was opened for, if any.
  const shown = (target: string) => {
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  void onEvent<null>("settings-shown", async () => shown((await Bridge.takeSettingsSection()) ?? ""));
  const pending = (await Bridge.takeSettingsSection()) ?? "";
  if (pending) shown(pending);
}

void main();
