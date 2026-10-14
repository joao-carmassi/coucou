// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, dot } from "../../../kit/dom";
import { ICONS } from "../icons";
import { COLOR } from "../../../kit/palette";
import { timeAgo } from "../../../kit/format";
import type { Pill } from "../../../core/moduleApi";
import { App } from "../../../kit/app";
import { tile, tileActions, tileCard, tileHead, tileStatus } from "../../../kit/tile";
import { ago as agoOf, empty } from "../../../kit/list";
import { type GithubActivityKind, type GithubData, type GithubTarget, IntegrationsBridge } from "../bridge";
import { GITHUB, PROVIDERS, info, steps } from "../store";

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = tileHead({ dot: color, title: name, sub: kind });
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (info[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string | undefined> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.url]));

function idleCard(task: Pill, openSettings: () => void): HTMLElement {
  const own = info[task.id];
  const configured = own?.configured ?? false;
  const error = own?.error ?? null;
  const missing = "Chave não configurada";
  const label = error ?? (configured ? "Conectado · carregando…" : missing);
  const statusColor = error || !configured ? "#F4505E" : "#22C55E";

  const actions: HTMLElement[] = [];
  if (task.id === "integration_n8n") {
    actions.push(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Abrir n8n",
        onclick: () => void IntegrationsBridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.push(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: `Abrir ${task.label}`,
        onclick: () => void App.openUrl(OPEN_URLS[task.id]!),
      }),
    );
  }
  if (configured) {
    actions.push(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Atualizar",
        onclick: () => void IntegrationsBridge.refreshIntegration(task.id),
      }),
    );
  } else {
    actions.push(
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Configurações…", onclick: openSettings }),
    );
  }

  return tile({ title: task.label, sub: "Integração", dot: task.color, status: [dot(statusColor, 5), h("span", { text: label })], actions });
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = agoOf(timeAgo(d.createdAt));
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: "Detalhes", onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return tileCard(undefined, header("#7C5CFF", "Vercel", "Deploys"), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? "Pronto" : d.state === "CANCELED" ? "Cancelado" : "Erro";
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: `há ${timeAgo(d.createdAt)}` }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void App.openUrl(`https://${d.url}`),
      }),
    );
  }
  return tileCard(
    "detail",
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? "Deploy") }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      agoOf(timeAgo(e.createdAt)),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return tileCard(undefined, header("#22C55E", "Resend", "E-mails", extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

/**
 * GitHub's dark-theme contribution colours, level 0 to 4 (Primer's
 * contribution-default-bgColor-*). The empty day is lifted a shade, since the
 * island's card is a little lighter than GitHub's page and #151B23 would
 * vanish on it.
 */
export const GITHUB_LEVELS = ["#1C2128", "#033A16", "#196C2E", "#2EA043", "#56D364"];

/** The GitHub pill's data, or null before the first answer. */
export function githubData(): GithubData | null {
  const d = get(GITHUB) as Partial<GithubData>;
  return typeof d.login === "string" ? (d as GithubData) : null;
}

/**
 * Icon and colour of each kind of activity. The colours are Mochi's own state
 * colours rather than GitHub's: a merged PR is green like `done`, a push
 * blue like `working`, an open issue amber like `alert`.
 */
export const ACTIVITY_STYLE: Record<GithubActivityKind | "review", { icon: string; color: string }> = {
  push: { icon: ICONS.commit, color: COLOR.blue },
  pr_opened: { icon: ICONS.pullRequest, color: COLOR.indigo },
  pr_merged: { icon: ICONS.merge, color: COLOR.green },
  pr_closed: { icon: ICONS.pullRequest, color: COLOR.grey },
  issue_opened: { icon: ICONS.issue, color: COLOR.amber },
  issue_closed: { icon: ICONS.issue, color: COLOR.grey },
  release: { icon: ICONS.tag, color: COLOR.cyan },
  create: { icon: ICONS.add, color: COLOR.dim },
  // A review asked for your eyes, like a question: Mochi's `ask` cyan.
  review: { icon: ICONS.pullRequest, color: COLOR.cyan },
};

/** "edu/coucou" → "coucou" for your own repositories, the full name otherwise. */
export function repoName(repo: string, login: string): string {
  const [owner, name] = repo.split("/");
  return name && owner.toLowerCase() === login.toLowerCase() ? name : repo;
}

/** 1284 → "1.3k", as the macOS card writes star counts. */
export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Days of the year's graph the card shows beside its figure: the last week. */
const CARD_DAYS = 7;
/** Lines of activity the card carries; it shows as many as its height allows. */
const CARD_LINES = 4;

/** What the panel is asked to open on: a line of activity's sheet, or nothing — its lists. */
export interface GithubOpening {
  target?: GithubTarget;
  label?: string;
  url?: string;
}

/**
 * What a line of the card says after its title: a fact of its own — "#12",
 * "v0.3.0", "3 commits" — or, failing one, the project it happened in. A
 * push's branch says less than its project.
 */
function activityWhere(a: GithubData["activity"][number], login: string): { text: string; fact: boolean } {
  const first = a.detail?.split(" · ")[0] ?? "";
  return /^(#\d+|v?\d)/.test(first) ? { text: first, fact: true } : { text: repoName(a.repo, login), fact: false };
}

/**
 * The summary in the overview, laid out like the Stripe card: one figure, then
 * what happened lately. The figure is the year's contributions, with the last
 * seven days as the squares GitHub draws them; it opens the panel. Each line
 * under it opens the panel on its own sheet.
 */
function githubCard(onPanel: (open?: GithubOpening) => void): HTMLElement {
  const d = githubData()!;
  const error = info[GITHUB]?.error ?? null;
  const c = d.contributions;

  const week = c
    ? h(
        "span",
        { class: "int-week", title: `Últimos ${CARD_DAYS} dias` },
        ...c.levels.slice(-CARD_DAYS).map((level) => h("i", { style: `background:${GITHUB_LEVELS[level] ?? GITHUB_LEVELS[0]}` })),
      )
    : null;
  // Without the year (the token may not read it), the stars are the figure.
  // While the pill has news, the way in leads to what the news is about.
  const news = info[GITHUB]?.news?.open;
  const figure = h(
    "button",
    { class: "int-balance int-figure", title: news?.title ?? "Abrir o painel do GitHub", onclick: () => onPanel() },
    h("span", { text: c ? c.total.toLocaleString("pt-BR") : compact(d.totalStars) }),
    h("i", { text: c ? "contribuições" : "estrelas" }),
    week,
  );

  const rows = h("div", { class: "int-rows tight" });
  for (const a of d.activity.slice(0, CARD_LINES)) {
    const style = ACTIVITY_STYLE[a.kind];
    const where = activityWhere(a, d.login);
    rows.append(
      h(
        "button",
        {
          class: "int-row int-go",
          // The whole of what the line cuts short.
          title: [a.title, repoName(a.repo, d.login), a.detail].filter(Boolean).join(" · "),
          onclick: () => onPanel({ target: a.target ?? undefined, label: a.title, url: a.url }),
        },
        dot(style.color, 5),
        h("span", { class: "int-name", text: a.title }),
        // A fact wears the line's colour, like an amount; a project is where, in grey.
        where.fact
          ? h("span", { class: "int-amount", style: `color:${style.color}`, text: where.text })
          : h("span", { class: "int-where", text: where.text }),
        agoOf(timeAgo(a.at)),
      ),
    );
  }
  if (d.activity.length === 0) rows.append(empty("Nada nos últimos 30 dias"));

  const stars = c && d.totalStars > 0
    ? h("span", { class: "int-total", title: "Estrelas em todos os seus repositórios" },
        h("i", { class: "int-star" }, svg(ICONS.star, 9)), h("span", { text: compact(d.totalStars) }))
    : undefined;
  const card = tileCard(undefined, header(COLOR.red, "GitHub", `@${d.login}`, stars));
  // What's shown is the last good answer; say why it isn't fresher.
  if (error) card.append(tileStatus(dot(COLOR.red, 5), h("span", { text: error })));
  card.append(figure, rows);
  return card;
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? "Pagamento") }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        agoOf(timeAgo(p.createdAt)),
      ),
    );
  }
  return tileCard(
    undefined,
    header("#0570DE", "Stripe", "Pagamentos"),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void App.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? "Sem título") }),
        agoOf(timeAgo(p.lastEditedAt)),
      ),
    );
  }
  return tileCard(undefined, header("#E8E8E8", "Notion", "Recentes"), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(empty("Nenhuma chamada agendada"));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? "Reunião") }),
      ),
    );
  }
  return tileCard(undefined, header("#C9956A", "Cal.com", "Agenda"), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: Pill, onDetail: () => void, openSettings: () => void): HTMLElement {
  const lines = steps.get(task.id) ?? [];
  const hasActivity = lines.length > 0 && (task.mood === "done" || task.mood === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.mood === "done";
  const accent = success ? "#22C55E" : "#F4505E";
  return tileCard(
    undefined,
    header("#F29B38", "n8n", "Workflow"),
    tileActions(
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: lines[0] ?? "Workflow" }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: Pill, onBack: () => void): HTMLElement {
  const lines = steps.get(task.id) ?? [];
  const success = task.mood === "done";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = lines[1];
  return tileCard(
    "detail",
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: lines[0] ?? "Workflow" }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? "Sucesso" : "Falhou",
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : tileStatus(success ? "Concluído com sucesso." : "Sem detalhes do erro."),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
  /** A view of its own, for the pills that outgrew the card (GitHub) — on a sheet, or on its lists. */
  openPanel(open?: GithubOpening): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const own = info[id];
  // GitHub keeps its last good snapshot through an error and says so itself;
  // a removed token, though, must not leave the old account on screen.
  if (id === "integration_github") return own?.configured !== false && githubData() != null;
  if (!own || own.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_stripe":
      return own.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return own.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: Pill, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_n8n") {
    const hasActivity = (steps.get(task.id)?.length ?? 0) > 0 && (task.mood === "done" || task.mood === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard(hooks.openPanel);
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    default:
      return idleCard(task, hooks.openSettings);
  }
}

