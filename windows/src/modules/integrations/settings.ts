// The Integrações section of the settings window: which pills are on (up to four), their keys in
// the Windows Credential Manager (never on disk), and GitHub's token with a connection test.
// Port of the integrations part of settings/main.ts at m3-ok. The window renders it only while
// the module is on (ModuleDef.settings).

import { Bridge, type GithubAccount } from "../../core/bridge";
import { State } from "../../core/state";
import { h, clear } from "../../views/dom";
import { GITHUB, MAX_ACTIVE, PROVIDERS, integrationSettings, type Provider } from "./store";

const save = () => void Bridge.saveSettings(State.settings);

/** Green for what is in place, red for what is missing. */
const statusColor = (ok: boolean) => (ok ? "var(--green)" : "var(--red)");
const statusDot = (ok: boolean) => h("i", { class: "dot", style: `background:${statusColor(ok)}` });

// ── GitHub setup ──────────────────────────────────────────────────────────────

const GITHUB_KEY = "github-token";
const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const DAY_MS = 86_400_000;
/** A token this close to its end gets a word about it. */
const EXPIRES_SOON_DAYS = 7;

interface Setup {
  /** Where it stands, on the integration's own line. */
  status: HTMLElement;
  /** Opens under the line while the integration is on. */
  panel: HTMLElement;
}

/** GitHub's line in the integrations, and what opens under it once it is on. */
function githubSetup(present: Record<string, boolean>): Setup {
  const dot = statusDot(present[GITHUB_KEY] ?? false);
  const state = h("span", { class: "hint" });
  const field = h("input", {
    type: "password", style: "flex:1 1 auto;min-width:0", autocomplete: "off", spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Salvar token" });
  const clearBtn = h("button", { class: "danger", text: "Remover" });
  const testBtn = h("button", { text: "Testar conexão" });
  const feedback = h("div", {});

  function show(has: boolean) {
    present[GITHUB_KEY] = has;
    dot.style.background = statusColor(has);
    state.textContent = has
      ? "Token salvo no Gerenciador de Credenciais do Windows."
      : "Ainda sem token — a pílula do GitHub precisa de um.";
    field.placeholder = has ? "••••••••••••  (salva)" : "github_pat_…";
    clearBtn.style.display = has ? "" : "none";
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
      void Bridge.refreshIntegration(GITHUB);
      return true;
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Não foi possível salvar: ${String(err)}` }));
      return false;
    }
  }

  saveBtn.addEventListener("click", async () => {
    if (!field.value.trim()) return;
    clear(feedback);
    if (await store()) feedback.append(h("div", { class: "notice ok", text: "Salvo. Nunca vai para o disco — teste abaixo." }));
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

  // A token pasted but not saved yet is saved first: the test only ever runs on the stored token,
  // so the value never has to travel anywhere else.
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
    class: "link", text: "token fine-grained", onclick: () => void Bridge.openUrl(GITHUB_NEW_TOKEN_URL),
  });

  show(present[GITHUB_KEY] ?? false);

  const status = h("div", { class: "row", style: "gap:8px;padding-top:5px" }, dot, state);
  const panel = h("div", { class: "setup" },
    h("div", { class: "row" }, h("label", { text: "Token" }), field, saveBtn, clearBtn),
    h("div", { class: "hint" },
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
    list.append(h("li", {}, statusDot(c.ok), h("span", { text: c.label }), c.note ? h("span", { class: "check-note", text: c.note }) : null));
  }
  return h("div", { class: missing ? "notice warn" : "notice ok" },
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

// ── The section ───────────────────────────────────────────────────────────────

function providerLine(def: Provider, present: Record<string, boolean>, onToggle: () => void): HTMLElement {
  const mine = integrationSettings();
  const active = mine.activeIntegrations.includes(def.id);
  const setup = def.id === GITHUB ? githubSetup(present) : null;
  const drawer = setup ? h("div", { class: "drawer" }, h("div", {}, setup.panel)) : null;
  const open = (on: boolean) => {
    drawer?.classList.toggle("open", on);
    // Folded away, its fields are out of reach of the keyboard too.
    if (setup) setup.panel.inert = !on;
  };
  open(active);

  const sw = h("button", { class: active ? "switch on" : "switch", "aria-pressed": active });
  sw.addEventListener("click", () => {
    const list = integrationSettings().activeIntegrations;
    const on = list.includes(def.id);
    if (!on && list.length >= MAX_ACTIVE) return;
    integrationSettings().activeIntegrations = on ? list.filter((x) => x !== def.id) : [...list, def.id];
    sw.classList.toggle("on", !on);
    sw.setAttribute("aria-pressed", String(!on));
    open(!on);
    onToggle();
    save();
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
        dotEl.style.background = statusColor(value.length > 0);
      } catch {
        dotEl.style.background = "#f5a524";
      }
    });
    rows.append(h("div", { class: "row" }, h("label", { style: "min-width:104px", text: field.label }), input, saveBtn, dotEl));
  }

  const line = h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
    h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
      sw,
      h("i", { class: "dot", style: `background:${def.color}` }),
      h("span", { style: "font-size:12.5px", text: def.name }),
    ),
    rows,
  );
  return drawer ? h("div", {}, line, drawer) : line;
}

export function integrationsSettingsSection(): { el: HTMLElement; dispose(): void } {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const updateNote = () => {
    const used = integrationSettings().activeIntegrations.length;
    note.textContent = `Escolha até ${MAX_ACTIVE} pílulas para mostrar ao lado do Mochi — ${used}/${MAX_ACTIVE} em uso. As chaves ficam no Gerenciador de Credenciais do Windows, nunca no disco.`;
  };
  updateNote();
  const el = h("section", { id: "integrations" }, h("h2", {}, h("span", { text: "Integrações" })), note, list);

  // Which keys exist is asked of Rust: the list is drawn once it answers.
  let gone = false;
  void (async () => {
    const present: Record<string, boolean> = {};
    for (const p of PROVIDERS) for (const f of p.fields) present[f.key] = (await Bridge.secretPresent(f.key)) ?? false;
    present[GITHUB_KEY] = (await Bridge.secretPresent(GITHUB_KEY)) ?? false;
    if (gone) return;
    list.replaceChildren(...PROVIDERS.map((p) => providerLine(p, present, updateNote)));
  })();

  return { el, dispose: () => { gone = true; } };
}
