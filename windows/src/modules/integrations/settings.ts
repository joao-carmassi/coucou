// The Integrações section of the settings window: the keys of each integration in
// the Windows Credential Manager (never on disk), and GitHub's token with a connection test.
// Port of the integrations part of settings/main.ts at m3-ok. The window renders it only while
// the module is on (modules/settings.ts).

import { Bridge } from "../../core/bridge";
import "./settings.css";
import { type GithubAccount, IntegrationsBridge } from "./bridge";
import { h, clear } from "../../views/dom";
import { GITHUB, PROVIDERS, moduleIdOf, type Provider } from "./providers";

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
    show((await IntegrationsBridge.secretPresent(GITHUB_KEY)) ?? false);
  }

  /** Saves whatever is in the field. True when there was nothing to save, too. */
  async function store(): Promise<boolean> {
    const value = field.value.trim();
    if (!value) return true;
    try {
      await IntegrationsBridge.secretSet(GITHUB_KEY, value);
      field.value = "";
      await refresh();
      // Fill the pill now rather than at the next poll.
      void IntegrationsBridge.refreshIntegration(GITHUB);
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
      await IntegrationsBridge.secretClear(GITHUB_KEY);
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
      feedback.append(githubResult(await IntegrationsBridge.githubTest()));
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

/** One provider's section, shown while its module is on: its secret fields (GitHub: token, test, help). */
export function providerSettingsSection(def: Provider): { el: HTMLElement; dispose(): void } {
  const present: Record<string, boolean> = {};
  const list = h("div", { style: "display:flex;flex-direction:column;gap:6px;min-width:0" });
  const el = h("section", { id: `integration-${def.id.slice("integration_".length)}` },
    h("h2", {}, h("span", { text: def.name })), list);

  let gone = false;
  void (async () => {
    for (const f of def.fields) present[f.key] = (await IntegrationsBridge.secretPresent(f.key)) ?? false;
    present[GITHUB_KEY] = (await IntegrationsBridge.secretPresent(GITHUB_KEY)) ?? false;
    if (gone) return;
    if (def.id === GITHUB) {
      const setup = githubSetup(present);
      list.replaceChildren(setup.status, setup.panel);
    }
    for (const field of def.fields) list.append(fieldRow(field, present));
  })();

  return { el, dispose: () => { gone = true; } };
}

function fieldRow(field: Provider["fields"][number], present: Record<string, boolean>): HTMLElement {
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
      await IntegrationsBridge.secretSet(field.key, value);
      present[field.key] = value.length > 0;
      input.value = "";
      input.placeholder = value ? "••••••••  (salva)" : field.placeholder;
      dotEl.style.background = statusColor(value.length > 0);
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  return h("div", { class: "row" }, h("label", { style: "min-width:104px", text: field.label }), input, saveBtn, dotEl);
}

export const settingsSections = Object.fromEntries(PROVIDERS.map((p) => [moduleIdOf(p), () => providerSettingsSection(p)]));
