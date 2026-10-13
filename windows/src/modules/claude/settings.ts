// The Claude section of the settings window: hooks (Windows and WSL), the second account,
// what the idle card opens, the "go to alert" hotkey. The window renders it only while the
// module is on (ModuleDef.settings). Everything that writes to disk is confirmed here: the
// exact diff is shown, the file is backed up, and a file that changed in between is refused.
//
// The settings window keeps one Settings object in State.settings (settings/main.ts), so a
// field changed here travels with the window's own saves.

import { Bridge, type HookPreview, type HookStatus, type WslStatus } from "../../core/bridge";
import { State } from "../../core/state";
import { h, clear } from "../../views/dom";
import { claudeSettings } from "./store";

/** main.ts fires this on `window` every time the settings window comes up (WSL is slow, so only then). */
export const SETTINGS_SHOWN = "coucou:settings-shown";

const save = () => Bridge.saveSettings(State.settings);

/** Runs `fn` every time the window comes up, for as long as `el` is on the page. */
function onShown(el: HTMLElement, fn: () => void) {
  const on = () => {
    if (el.isConnected) fn();
    else window.removeEventListener(SETTINGS_SHOWN, on);
  };
  window.addEventListener(SETTINGS_SHOWN, on);
}

/** Green for what is in place, red for what is missing. */
const statusColor = (ok: boolean) => (ok ? "var(--green)" : "var(--red)");

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${statusColor(ok)}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

/** A second Claude account: where Claude Code on Windows keeps its sign-in and sessions. */
function accountRow(): HTMLElement {
  const field = h("input", {
    type: "text",
    value: claudeSettings().claudeConfigDir ?? "",
    placeholder: "~/.claude",
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
  }) as HTMLInputElement;
  field.addEventListener("change", () => {
    claudeSettings().claudeConfigDir = field.value.trim();
    void save();
  });
  return h("div", { class: "row" },
    h("label", { text: "Pasta da conta" }),
    field,
    h("span", { class: "hint", text: "Opcional. Outra pasta de configuração do Claude Code, para as sessões. Vazio = a padrão." }),
  );
}

/** What the idle Claude card opens when no session is going. */
function idleOpenRow(cli: string | null): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(
    h("option", { value: "", text: "Visual Studio Code" }),
    h("option", { value: "terminal", text: "Terminal (Claude Code)" }),
  );
  const term = select.options[1];
  term.disabled = !cli;
  if (!cli) term.title = "O Claude Code não está instalado no Windows.";
  select.value = claudeSettings().idleOpen === "terminal" && cli ? "terminal" : "";
  select.addEventListener("change", () => {
    claudeSettings().idleOpen = select.value;
    void save();
  });
  return h("div", { class: "row" },
    h("label", { text: "Botão em repouso abre" }),
    select,
    h("span", { class: "hint", text: "Sem nenhuma sessão ativa. O Terminal inicia o Claude Code na sua pasta pessoal, na conta acima." }),
  );
}

/** Global hotkey that takes the island to the card waiting for an answer. */
function alertHotkeyRow(): HTMLElement {
  const input = h("input", {
    type: "text", value: claudeSettings().alertHotkey ?? "", spellcheck: "false", placeholder: "ex.: Ctrl+Alt+A",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    claudeSettings().alertHotkey = input.value.trim();
    void save();
  });
  return h("div", { class: "row" },
    h("label", { text: "Atalho \"ir ao alerta\"" }),
    input,
    h("span", { class: "hint", text: "Desligado por padrão; vazio = sem atalho." }),
  );
}

// ── Diff → confirm → write ────────────────────────────────────────────────────
// The one path by which hooks are ever written, for Windows and WSL alike: show
// the exact diff and the backup, write only on the click, and refuse a file
// that changed in between (the fingerprint).

interface FlowOps {
  preview: () => Promise<HookPreview>;
  apply: (fingerprint: string) => Promise<string>;
  back: () => void;
  done: () => void;
  /** Named in the hint: "This is exactly what will change in your …". */
  what: string;
  /** Extra line shown above the diff, e.g. the relay script that comes with it. */
  extra?: string;
}

async function previewFlow(body: HTMLElement, install: boolean, ops: FlowOps) {
  let preview: HookPreview;
  try {
    preview = await ops.preview();
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: "Voltar", onclick: ops.back })),
    );
    return;
  }
  clear(body);
  body.append(
    h("div", {
      class: "hint",
      text: install
        ? `É exatamente isto que vai mudar no seu ${ops.what}. Seus próprios hooks ficam intactos.`
        : "Isso remove só as entradas do Coucou. Seus próprios hooks ficam intactos.",
    }),
  );
  if (ops.extra) body.append(h("div", { class: "hint", text: ops.extra }));
  body.append(
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", { class: "path", text: `Backup → ${preview.backup}` }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? "Fazer backup e gravar" : "Fazer backup e remover",
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await ops.apply(preview.fingerprint);
      clear(body);
      body.append(h("div", {
        class: "notice ok",
        text: `Pronto. Configurações anteriores salvas como ${backup}. Abra uma nova sessão do Claude Code para os hooks entrarem em ação.`,
      }));
      window.setTimeout(ops.done, 2600);
    } catch (err) {
      confirm.disabled = false;
      body.append(h("div", { class: "notice err", text: `Não foi possível gravar: ${String(err)}` }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: "Cancelar", onclick: ops.back })));
}

// ── Claude Code section ───────────────────────────────────────────────────────

const NO_STATUS: HookStatus = { installed: false, settingsPath: "", hookPath: "", hookReady: false, claudeCli: null };

function hooksSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    { id: "claude" },
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "O Coucou está conectado às suas sessões do Claude Code. Chamadas de ferramentas, perguntas e pedidos de permissão aparecem na ilha, e você responde por lá."
          : "Instale os hooks para ver suas sessões do Claude Code na ilha e aprovar permissões sem sair do que está fazendo.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
      accountRow(),
      idleOpenRow(status.claudeCli),
      alertHotkeyRow(),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "O coucou-hook.exe ainda não está no lugar. Reinicie o Coucou; se continuar falhando, gere-o com `cargo build -p coucou-hook`.",
      }));
    }

    // One row per Claude Code profile (~/.claude, ~/.claude-qf…). The default
    // profile passes no configDir; every one goes through the same reviewed diff.
    void Bridge.claudeProfiles().then((list) => {
      const profiles = list && list.length ? list : [null];
      for (const p of profiles) {
        const dir = p && !p.isDefault ? p.configDir : undefined;
        const actions = h("div", { class: "row" });
        if (p && profiles.length > 1) actions.append(h("label", { text: p.label }));
        body.append(actions);
        void (async () => {
          const st = dir ? ((await Bridge.hooksStatus(dir)) ?? status) : status;
          const install = h("button", {
            class: "primary",
            text: st.installed ? "Reinstalar hooks…" : "Instalar hooks…",
            onclick: () => showPreview(true, dir),
          });
          // Writing hook commands that point at a relay which isn't there would give
          // every Claude Code session a broken hook and nothing to show for it.
          if (!status.hookReady) {
            install.disabled = true;
            install.title = "O relay ainda não está instalado.";
          }
          actions.append(install);
          if (st.installed) {
            actions.append(h("button", {
              class: "danger",
              text: "Desinstalar hooks…",
              onclick: () => showPreview(false, dir),
            }));
          }
        })();
      }
    });
  }

  function showPreview(install: boolean, configDir?: string) {
    void previewFlow(body, install, {
      preview: () => Bridge.hooksPreview(install, configDir),
      apply: (fingerprint) => Bridge.hooksApply(install, fingerprint, configDir),
      back: () => { clear(body); draw(); },
      done: () => void rebuild(),
      what: "settings.json",
    });
  }

  // Claude Code may have been installed (or signed in) since launch.
  onShown(section, () => void rebuild());

  void rebuild();
  return section;
}

// ── WSL section ───────────────────────────────────────────────────────────────
// Claude Code running inside a WSL distro. Each distro gets its own relay script
// and its own ~/.claude/settings.json, through the same reviewed-diff path.
// Asking a distro for its state starts it, so this only runs while the window
// is on screen (the shown cue), never at launch.

function wslSection(status: HookStatus): HTMLElement {
  const dot = statusDot(false);
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h("section", { id: "wsl" }, h("h2", {}, dot, h("span", { text: "WSL" })), body);
  body.append(h("div", { class: "hint", text: "Abra as configurações para procurar distribuições WSL." }));

  let busy = false;
  let statuses: WslStatus[] = [];

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      clear(body);
      body.append(h("div", { class: "hint", text: "Procurando distribuições WSL…" }));
      const names = (await Bridge.wslDistros()) ?? [];
      statuses = [];
      for (const name of names) {
        try {
          statuses.push(await Bridge.wslStatus(name));
        } catch (err) {
          statuses.push({
            distro: name, installed: false, settingsPath: "", relayPath: "",
            relayReady: false, claudeCli: null, error: String(err),
          });
        }
      }
      draw();
    } finally {
      busy = false;
    }
  }

  function draw() {
    clear(body);
    dot.style.background = statuses.some((s) => s.installed) ? "#22c55e" : "#f4505e";
    body.append(h("div", {
      class: "hint",
      text: statuses.length
        ? "O Claude Code rodando no WSL fala com o Coucou por um pequeno script relay na distribuição. Instale-o para ver essas sessões na ilha e aprovar as permissões."
        : "Nenhuma distribuição WSL encontrada. Instale uma com `wsl --install` e atualize.",
    }));
    for (const st of statuses) body.append(distroBlock(st));
    body.append(h("div", { class: "row" }, h("button", { text: "Atualizar", onclick: () => void refresh() })));
  }

  function distroBlock(st: WslStatus): HTMLElement {
    const block = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
    block.append(h("div", { class: "row" },
      statusDot(st.installed),
      h("span", { style: "font-weight:600", text: st.distro }),
    ));
    if (st.error) {
      block.append(h("div", { class: "notice warn", text: st.error }));
      return block;
    }
    block.append(
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: st.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Script relay" }),
        h("span", { class: "path", text: st.relayPath }),
        statusDot(st.relayReady),
      ),
    );
    if (st.installed && !st.relayReady) {
      block.append(h("div", {
        class: "notice warn",
        text: "Os hooks estão lá, mas o script relay está ausente ou desatualizado. Reinstale para corrigir.",
      }));
    }

    const back = () => draw();
    const show = (install: boolean) => {
      clear(block);
      block.append(h("div", { class: "row" }, h("span", { style: "font-weight:600", text: st.distro })));
      void previewFlow(block, install, {
        preview: () => Bridge.wslHooksPreview(st.distro, install),
        apply: (fingerprint) => Bridge.wslHooksApply(st.distro, install, fingerprint),
        back,
        done: () => void refresh(),
        what: `settings.json de ${st.distro}`,
        extra: install
          ? `O script relay é gravado em ${st.relayPath} junto com ele.`
          : `O script relay ${st.relayPath} também é removido.`,
      });
    };

    const install = h("button", {
      class: "primary",
      text: st.installed ? "Reinstalar hooks…" : "Instalar hooks…",
      onclick: () => show(true),
    });
    // Same rule as Windows: no hooks pointing at a relay that isn't there.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "O coucou-hook.exe ainda não está instalado — reinicie o Coucou.";
    }
    const actions = h("div", { class: "row" }, install);
    if (st.installed) {
      actions.append(h("button", { class: "danger", text: "Desinstalar hooks…", onclick: () => show(false) }));
    }
    block.append(actions);
    return block;
  }

  onShown(section, () => void refresh());
  return section;
}

/** The module's section: hooks, then WSL. */
export function claudeSettingsSection(): HTMLElement {
  // Shared by both sections: the hooks one refreshes it, the WSL one reads it when it draws.
  const status: HookStatus = { ...NO_STATUS };
  return h("div", { style: "display:flex;flex-direction:column;gap:22px" }, hooksSection(status), wslSection(status));
}
