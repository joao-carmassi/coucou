// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type GithubAccount, type HookPreview, type HookStatus, type WslStatus } from "../core/bridge";
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

// ── Mochi's engine ────────────────────────────────────────────────────────────
// Mochi's chat can run on the user's own Claude Code (Windows or a WSL distro)
// instead of the API key. One "Use for Mochi" switch per Claude Code; at most
// one is on, and with none on the API key is used.

const engineListeners: (() => void)[] = [];
const engineSwitches: { backend: string; el: HTMLElement }[] = [];

function engineLabel(backend: string): string {
  if (backend === "windows") return "Claude Code no Windows";
  if (backend.startsWith("wsl:")) return `Claude Code no WSL · ${backend.slice(4)}`;
  return "a API do Claude";
}

function syncEngine() {
  for (let i = engineSwitches.length - 1; i >= 0; i--) {
    const s = engineSwitches[i];
    if (!s.el.isConnected) engineSwitches.splice(i, 1); // a redrawn block
    else s.el.classList.toggle("on", settings.chatBackend === s.backend);
  }
  for (const fn of engineListeners) fn();
}

/** Why a found Claude Code can't answer yet, and the one command that fixes it. */
function signInNotice(backend: string, cli: string): HTMLElement {
  const wsl = backend.startsWith("wsl:");
  const app = !wsl && /\\Claude\\claude-code\\/i.test(cli);
  const why = wsl
    ? `Esse Claude Code não está conectado. Faça login uma vez em ${backend.slice(4)} e reabra as configurações:`
    : app
      ? "Essa é a cópia do Claude Code que vem com o app do Claude. O app só faz o login quando ele mesmo a executa, então, para o Mochi, ela precisa de um login próprio, uma vez. Rode isto em um terminal e reabra as configurações:"
      : "Esse Claude Code não está conectado. Faça login uma vez em um terminal e reabra as configurações:";
  const command = wsl ? "claude auth login" : `& "${cli}" auth login`;
  return h("div", { class: "notice warn" },
    h("div", { text: why }),
    h("code", { class: "cmd", text: command }),
  );
}

/** A second Claude account: where Claude Code on Windows keeps its sign-in and sessions. */
function accountRow(): HTMLElement {
  const field = h("input", {
    type: "text",
    value: settings.claudeConfigDir,
    placeholder: "~/.claude",
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
  }) as HTMLInputElement;
  field.addEventListener("change", () => {
    settings.claudeConfigDir = field.value.trim();
    void save();
  });
  return h("div", { class: "row" },
    h("label", { text: "Pasta da conta" }),
    field,
    h("span", { class: "hint", text: "Opcional. Outra pasta de configuração do Claude Code, para o chat e as sessões do Mochi. Vazio = a padrão." }),
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
  select.value = settings.idleOpen === "terminal" && cli ? "terminal" : "";
  select.addEventListener("change", () => {
    settings.idleOpen = select.value;
    void save();
  });
  return h("div", { class: "row" },
    h("label", { text: "Botão em repouso abre" }),
    select,
    h("span", { class: "hint", text: "Sem nenhuma sessão ativa. O Terminal inicia o Claude Code na sua pasta pessoal, na conta acima." }),
  );
}

function mochiRow(backend: string, cli: string | null, missing: string): HTMLElement {
  const sw = h("button", { class: settings.chatBackend === backend ? "switch on" : "switch" });
  engineSwitches.push({ backend, el: sw });
  if (!cli) {
    sw.disabled = true;
    sw.title = missing;
  }
  sw.addEventListener("click", () => {
    settings.chatBackend = settings.chatBackend === backend ? "api" : backend;
    void save();
    syncEngine();
  });
  const row = h("div", { class: "row" },
    h("label", { text: "Usar no Mochi" }),
    sw,
    h("span", {
      class: "hint",
      text: cli
        ? "O chat do Mochi responde por esse Claude Code — sua assinatura, sem API key."
        : missing,
    }),
  );
  const box = h("div", { style: "display:flex;flex-direction:column;gap:8px" }, row);
  // Installed is not enough: a Claude Code nobody signed in to can't answer.
  if (cli) {
    void Bridge.claudeLoggedIn(backend).then((loggedIn) => {
      if (loggedIn !== false) return;
      box.append(signInNotice(backend, cli));
      // Leave a switch that is already on alone, so it can still be turned off.
      if (settings.chatBackend !== backend) {
        sw.disabled = true;
        sw.title = "Faça login nesse Claude Code primeiro";
      }
    });
  }
  return box;
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

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
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
      mochiRow("windows", status.claudeCli, "O Claude Code não está instalado no Windows."),
      accountRow(),
      idleOpenRow(status.claudeCli),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "O coucou-hook.exe ainda não está no lugar. Reinicie o Coucou; se continuar falhando, gere-o com `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstalar hooks…" : "Instalar hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "O relay ainda não está instalado.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Desinstalar hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  function showPreview(install: boolean) {
    void previewFlow(body, install, {
      preview: () => Bridge.hooksPreview(install),
      apply: (fingerprint) => Bridge.hooksApply(install, fingerprint),
      back: () => { clear(body); draw(); },
      done: () => void rebuild(),
      what: "settings.json",
    });
  }

  // Claude Code may have been installed (or signed in) since launch.
  void onEvent<null>("settings-shown", () => void rebuild());

  draw();
  return section;
}

// ── WSL section ───────────────────────────────────────────────────────────────
// Claude Code running inside a WSL distro. Each distro gets its own relay script
// and its own ~/.claude/settings.json, through the same reviewed-diff path.
// Asking a distro for its state starts it, so this only runs while the window
// is on screen (the "settings-shown" cue), never at launch.

function wslSection(hookReady: boolean): { section: HTMLElement; refresh: () => Promise<void> } {
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
      mochiRow(`wsl:${st.distro}`, st.claudeCli, "O Claude Code não está instalado nessa distribuição."),
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
    if (!hookReady) {
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

  return { section, refresh };
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Chave salva no Gerenciador de Credenciais do Windows." : "Ainda sem chave — o chat precisa de uma." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (salva)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Salvar chave" });
  const clearBtn = h("button", { class: "danger", text: "Remover" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = statusColor(present);
    state.textContent = present
      ? "Chave salva no Gerenciador de Credenciais do Windows."
      : "Ainda sem chave — o chat precisa de uma.";
    field.placeholder = present ? "••••••••••••  (salva)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Salva. Nunca vai para o disco." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Não foi possível salvar: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Chave removida." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Não foi possível remover: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  const engine = h("div", { class: "notice" });
  const drawEngine = () => {
    const api = settings.chatBackend === "api";
    engine.className = api ? "hint" : "notice ok";
    engine.textContent = api
      ? "O Mochi responde com essa chave. Para usar sua assinatura do Claude, ative \"Usar no Mochi\" em um Claude Code acima."
      : `O Mochi responde por ${engineLabel(settings.chatBackend)}, na sua assinatura — a chave abaixo não é usada. O modelo é o do próprio Claude Code.`;
  };
  engineListeners.push(drawEngine);
  drawEngine();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    engine,
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Modelo" }), model),
    feedback,
  );
}

// ── GitHub setup ──────────────────────────────────────────────────────────────

const GITHUB_ID = "integration_github";
const GITHUB_KEY = "github-token";
const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const DAY_MS = 86_400_000;
/** A token this close to its end gets a word about it. */
const EXPIRES_SOON_DAYS = 7;

/** GitHub's line in the integrations, and what opens under it once it is on. */
function githubSetup(present: Record<string, boolean>): IntegrationSetup {
  const hasToken = present[GITHUB_KEY] ?? false;
  const dot = statusDot(hasToken);
  const state = h("span", { class: "hint" });

  const field = h("input", {
    type: "password",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Salvar token" });
  const clearBtn = h("button", { class: "danger", text: "Remover" });
  const testBtn = h("button", { text: "Testar conexão" });
  const feedback = h("div", {});

  function show(present: boolean) {
    dot.style.background = statusColor(present);
    state.textContent = present
      ? "Token salvo no Gerenciador de Credenciais do Windows."
      : "Ainda sem token — a pílula do GitHub precisa de um.";
    field.placeholder = present ? "••••••••••••  (salva)" : "github_pat_…";
    clearBtn.style.display = present ? "" : "none";
  }

  async function refresh() {
    show((await Bridge.secretPresent(GITHUB_KEY)) ?? false);
  }

  /** Saves whatever is in the field. True when there was nothing to save, too. */
  async function store(): Promise<boolean> {
    const value = field.value.trim();
    if (!value) return true;
    try {
      await Bridge.secretSet(GITHUB_KEY, value);
      field.value = "";
      await refresh();
      // Fill the pill now rather than at the next poll.
      void Bridge.refreshIntegration(GITHUB_ID);
      return true;
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Não foi possível salvar: ${String(err)}` }));
      return false;
    }
  }

  saveBtn.addEventListener("click", async () => {
    if (!field.value.trim()) return;
    clear(feedback);
    if (await store()) {
      feedback.append(h("div", { class: "notice ok", text: "Salvo. Nunca vai para o disco — teste abaixo." }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(GITHUB_KEY);
      feedback.append(h("div", { class: "notice ok", text: "Token removido." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Não foi possível remover: ${String(err)}` }));
    }
  });

  // A token pasted but not saved yet is saved first: the test only ever runs on
  // the stored token, so the value never has to travel anywhere else.
  testBtn.addEventListener("click", async () => {
    clear(feedback);
    if (!(await store())) return;
    testBtn.disabled = true;
    testBtn.textContent = "Testando…";
    try {
      feedback.append(githubResult(await Bridge.githubTest()));
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Testar conexão";
    }
  });

  const newToken = h("button", {
    class: "link",
    text: "token fine-grained",
    onclick: () => void Bridge.openUrl(GITHUB_NEW_TOKEN_URL),
  });

  show(hasToken);

  const status = h("div", { class: "row", style: "gap:8px;padding-top:5px" }, dot, state);
  const panel = h(
    "div",
    { class: "setup" },
    h("div", { class: "row" }, h("label", { text: "Token" }), field, saveBtn, clearBtn),
    h(
      "div",
      { class: "hint" },
      "Crie um ", newToken, " com ",
      h("b", { text: "Repository access: All repositories" }), ", depois, em ",
      h("b", { text: "Repository permissions" }), ", defina ",
      h("b", { text: "Actions" }), ", ", h("b", { text: "Contents" }), ", ",
      h("b", { text: "Deployments" }), ", ", h("b", { text: "Issues" }), " e ",
      h("b", { text: "Pull requests" }),
      " como Read-only (Metadata é adicionado automaticamente). Em ",
      h("b", { text: "Account permissions" }), ", ", h("b", { text: "Events" }),
      " Read-only é opcional e inclui sua atividade privada. Nada além disso — o Coucou só lê.",
    ),
    h("div", { class: "row" }, testBtn),
    feedback,
  );
  return { status, panel };
}

function githubResult(account: GithubAccount): HTMLElement {
  const missing = account.checks.some((c) => !c.ok);
  const who = account.name ? `@${account.login} (${account.name})` : `@${account.login}`;
  const list = h("ul", { class: "checks" });
  for (const c of account.checks) {
    list.append(
      h("li", {}, statusDot(c.ok), h("span", { text: c.label }), c.note ? h("span", { class: "check-note", text: c.note }) : null),
    );
  }
  return h(
    "div",
    { class: missing ? "notice warn" : "notice ok" },
    h("div", { text: `Conectado como ${who}.` }),
    h("div", { text: tokenExpiry(account.expiresAt) }),
    list,
  );
}

/** "2026-12-12 10:00:00 +0100" → a date, with a nudge when it is close. */
function tokenExpiry(raw: string | null): string {
  if (!raw) return "Esse token não tem data de expiração.";
  const date = new Date(raw.slice(0, 10));
  if (Number.isNaN(date.getTime())) return `O token expira em ${raw}.`;
  const when = date.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
  const days = Math.ceil((date.getTime() - Date.now()) / DAY_MS);
  if (days < 0) return `Esse token expirou em ${when}.`;
  if (days <= EXPIRES_SOON_DAYS) return `O token expira em ${when} — em ${days} ${days === 1 ? "dia" : "dias"}. Crie um novo em breve.`;
  return `O token expira em ${when}.`;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** For an integration that needs more than its fields. */
  setup?: (present: Record<string, boolean>) => IntegrationSetup;
}

interface IntegrationSetup {
  /** Where it stands, on the integration's own line. */
  status: HTMLElement;
  /** Opens under the line while the integration is on. */
  panel: HTMLElement;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Chave secreta", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [], setup: githubSetup },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "URL da instância", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Token de integração", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Escolha até ${MAX_ACTIVE} pílulas para mostrar ao lado do Mochi — ${used}/${MAX_ACTIVE} em uso. As chaves ficam no Gerenciador de Credenciais do Windows, nunca no disco.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    const setup = def.setup?.(present);
    const drawer = setup ? h("div", { class: "drawer" }, h("div", {}, setup.panel)) : null;
    const open = (on: boolean) => {
      drawer?.classList.toggle("open", on);
      // Folded away, its fields are out of reach of the keyboard too.
      if (setup) setup.panel.inert = !on;
    };
    open(active);
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      open(!on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    if (setup) rows.append(setup.status);
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (salva)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Salvar" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (salva)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    const line = h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
      h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
        sw,
        h("i", { class: "dot", style: `background:${def.color}` }),
        h("span", { style: "font-size:12.5px", text: def.name }),
      ),
      rows,
    );
    list.append(drawer ? h("div", {}, line, drawer) : line);
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrações" })), note, list);
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
      h("label", { text: "A ilha fica em" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Iniciar com o Windows" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false, claudeCli: null,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  const wsl = wslSection(status.hookReady);

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    wsl.section,
    apiSection(hasKey),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "Sem telemetria. As requisições de rede só vão para os serviços que você mesmo configurar.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });

  // Every time the window comes up: refresh WSL (slow, so only while someone is
  // looking) and scroll to the section it was opened for, if any.
  const shown = (target: string) => {
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    void wsl.refresh();
  };
  void onEvent<null>("settings-shown", async () => shown((await Bridge.takeSettingsSection()) ?? ""));
  // The first-launch offer can show the window before this page has loaded; the
  // section it left behind says so. (The window is hidden at every other launch,
  // and nothing here may start a distro then.)
  const pending = (await Bridge.takeSettingsSection()) ?? "";
  if (pending) shown(pending);
}


void main();
