// Estatísticas de IA view, three tabs over the indexed days: "Hoje", "7 dias", "30 dias". Each shows tiles (input,
// output, estimated cost, requests, cache), the models and projects, a daily chart (not "Hoje") and the Claude / Codex
// split. Reads logs only while it is on screen.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { AistatsBridge } from "./bridge";
import {
  LIST_MAX, PRICES_DATE, cacheHit, costOf, costTotal, dayLabel, fitHeight, fmtTokens, fmtUsd, lastDays, modelName, period, split,
  sumOf, weekdayLabel, type Summary, type Tab,
} from "./logic";

const SPAN: Record<Tab, number> = { today: 1, week: 7, month: 30 };
const COST_NOTE = `Custo estimado pela tabela de preços de ${PRICES_DATE.split("-").reverse().join("/")}; modelo sem preço não entra.`;

const pct = (v: number, max: number) => (max > 0 ? Math.min(100, Math.round((v / max) * 1000) / 10) : 0);
const pctText = (r: number) => `${Math.round(r * 100)}%`;

function bar(fill: number, cls = "") {
  const i = h("i");
  i.style.width = `${fill > 0 ? Math.max(2, fill) : 0}%`;
  return h("span", { class: `aistats-bar${cls ? ` ${cls}` : ""}` }, i);
}
function tile(k: string, v: string, foot: string | HTMLElement, title?: string) {
  return h("div", { class: "aistats-tile", title }, h("span", { class: "aistats-k", text: k }), h("b", { class: "aistats-v", text: v }),
    typeof foot === "string" ? h("span", { class: "aistats-foot", text: foot }) : foot);
}
/** A heading and up to LIST_MAX rows (name and amount over a bar); the rest is counted in the heading. */
function list(k: string, items: { name: string; n: number; title: string }[], empty: string) {
  const rest = items.slice(LIST_MAX);
  const aside = rest.length ? h("span", { class: "aistats-foot", text: `+${rest.length} ${rest.length === 1 ? "outro" : "outros"}`, title: rest.map((r) => r.name).join(", ") }) : null;
  const rows = items.slice(0, LIST_MAX).map((r) => h("div", { class: "aistats-row", title: r.title },
    h("span", { class: "aistats-line" }, h("span", { class: "aistats-name", text: r.name }), h("span", { class: "aistats-num", text: fmtTokens(r.n) })),
    bar(pct(r.n, items[0].n))));
  return h("div", { class: "aistats-sec" },
    h("div", { class: "aistats-sec-head" }, h("span", { class: "aistats-k", text: k }), aside),
    rows.length ? h("div", { class: "aistats-list" }, ...rows) : h("div", { class: "aistats-none", text: empty }));
}

/** Tokens per day of `keys`, each column split Claude (bottom) / Codex (top), with the dashed average of the days with use. */
function chart(s: Summary, keys: string[], today: string) {
  const days = new Map(s.days.map((d) => [d.day, d]));
  const per = keys.map((k) => split(Object.entries(days.get(k)?.models ?? {})));
  const totals = per.map((p) => p.claude + p.codex);
  const used = totals.filter((t) => t > 0);
  const avg = used.length ? used.reduce((a, b) => a + b, 0) / used.length : 0;
  const max = Math.max(0, ...totals);
  const plot = h("div", { class: "aistats-plot", style: `grid-template-columns:repeat(${keys.length},1fr)` }, ...keys.map((k, i) => {
    const seg = (cls: string, v: number) => h("i", { class: cls, style: `height:${pct(v, totals[i])}%` });
    const tip = `${dayLabel(k)} · ${fmtTokens(totals[i])} tokens${totals[i] ? ` (Claude ${fmtTokens(per[i].claude)}, Codex ${fmtTokens(per[i].codex)})` : ""}`;
    return h("span", { class: k === today ? "aistats-col today" : "aistats-col", title: tip },
      h("span", { class: "aistats-stack", style: `height:${totals[i] ? Math.max(3, pct(totals[i], max)) : 0}%` }, seg("codex", per[i].codex), seg("claude", per[i].claude)));
  }));
  if (avg) plot.append(h("i", { class: "aistats-avg", style: `bottom:${pct(avg, max)}%`, title: `Média: ${fmtTokens(avg)} por dia com uso` }));
  const axis = keys.length <= 7
    ? h("div", { class: "aistats-axis", style: `grid-template-columns:repeat(${keys.length},1fr)` },
      ...keys.map((k) => h("span", { class: k === today ? "today" : undefined, text: weekdayLabel(k) })))
    : h("div", { class: "aistats-axis ends" },
      h("span", { text: dayLabel(keys[0], false) }), h("span", { text: dayLabel(keys[keys.length >> 1], false) }), h("span", { class: "today", text: "hoje" }));
  return h("div", { class: "aistats-sec aistats-chart" },
    h("div", { class: "aistats-sec-head" }, h("span", { class: "aistats-k", text: "Tokens por dia" }),
      avg ? h("span", { class: "aistats-foot", text: `média ${fmtTokens(avg)}` }) : null),
    plot, axis);
}

export function buildView(ctx: ViewContext): ViewHost {
  let tab: Tab = "today";
  let sum: Summary | null | undefined; // undefined: not read yet
  let rows = 0;
  let empty = true;
  let busy = false;
  let shown = false;

  const tabBtn = (t: Tab, text: string) => h("button", { type: "button", role: "tab", text, onclick: () => { tab = t; draw(); } });
  const tabs: Record<Tab, HTMLButtonElement> = { today: tabBtn("today", "Hoje"), week: tabBtn("week", "7 dias"), month: tabBtn("month", "30 dias") };
  const when = h("span", { class: "aistats-when" });
  const status = h("span", { class: "aistats-foot" });
  const head = h("div", { class: "aistats-head" }, when, status, h("div", { class: "grow" }),
    h("button", { type: "button", class: "link-btn text-link", text: "Atualizar", onclick: () => void load() }),
    h("div", { class: "seg aistats-tabs", role: "tablist", "aria-label": "Período" }, tabs.today, tabs.week, tabs.month));
  const panel = h("div", { class: "aistats-panel", role: "tabpanel" });
  const body = h("div", { class: "stack scroll aistats-view" }, head, panel);
  const el = view(card(null, body));

  const content = (s: Summary, keys: string[]): HTMLElement[] => {
    const today = keys[keys.length - 1];
    const p = period(s.days, keys);
    const t = p.tok;
    const cost = costTotal(p.models);
    const hit = cacheHit(t);
    const prov = split(p.models);
    const all = prov.claude + prov.codex;
    const models = p.models.map(([m, mt]) => {
      const c = costOf(m, mt);
      return { name: modelName(m), n: sumOf(mt), title: `${m} · ${c === null ? "sem preço" : `${fmtUsd(c)} (estimativa)`}` };
    });
    const projects = p.projects.map(([name, n]) => ({ name, n, title: name }));
    const nothing = tab === "today" ? "Nada hoje." : "Nada no período.";
    const noProjects = prov.codex && !prov.claude ? "O Codex não separa por projeto." : nothing;
    rows = Math.max(Math.min(models.length, LIST_MAX), Math.min(projects.length, LIST_MAX));
    const lists = [list("Modelos", models, nothing), list("Projetos", projects, noProjects)];
    const share = (k: "claude" | "codex", label: string) =>
      h("span", { class: `aistats-who ${k}`, title: `${label}: ${fmtTokens(prov[k])} tokens` }, h("i"), `${label} ${all ? pctText(prov[k] / all) : "–"}`);
    return [
      h("div", { class: "aistats-tiles" },
        tile("Entrada", fmtTokens(t.input), `+${fmtTokens(t.cache_read + t.cache_write)} em cache`, "Tokens enviados fora do cache; o cache lido e gravado vem à parte."),
        tile("Saída", fmtTokens(t.output), t.reasoning ? `${fmtTokens(t.reasoning)} de raciocínio` : "tokens gerados"),
        tile("Custo est.", fmtUsd(cost.usd), cost.partial ? `sem preço: ${cost.missing.map(modelName).join(", ")}` : "estimativa",
          cost.partial ? `${COST_NOTE} Sem preço: ${cost.missing.join(", ")}.` : COST_NOTE),
        tile("Pedidos", t.req ? t.req.toLocaleString("pt-BR") : "–",
          p.reqPartial ? "parcial: dias antigos" : t.req ? `${fmtTokens(Math.round(sumOf(t) / t.req))} por pedido` : "nenhum",
          p.reqPartial ? "Pedidos são contados a partir desta versão. Apagar estatísticas (nas configurações) conta tudo de novo." : undefined),
        tile("Cache", hit === null ? "–" : pctText(hit), hit === null ? "nada enviado" : bar(Math.round(hit * 1000) / 10, "ok"), "Parte da entrada lida do cache.")),
      tab === "today" ? h("div", { class: "aistats-mid two" }, ...lists) : h("div", { class: "aistats-mid three" }, chart(s, keys, today), ...lists),
      h("div", { class: "aistats-end" },
        share("claude", "Claude"),
        h("span", { class: "aistats-split" },
          h("i", { class: "claude", style: `width:${all ? pct(prov.claude, all) : 0}%` }), h("i", { class: "codex", style: `width:${all ? pct(prov.codex, all) : 0}%` })),
        share("codex", "Codex"),
        h("div", { class: "grow" }),
        h("span", { class: s.approx ? "aistats-note approx" : "aistats-note", title: `${COST_NOTE}${s.approx ? " Algum registro foi reescrito: os números são aproximados." : ""}`,
          text: `custo estimado · preços de ${dayLabel(PRICES_DATE, false)}${s.approx ? " · números aproximados" : ""}` })),
    ];
  };

  const draw = (resize = true) => {
    for (const t of Object.keys(tabs) as Tab[]) {
      tabs[t].classList.toggle("on", t === tab);
      tabs[t].setAttribute("aria-selected", String(t === tab));
    }
    const keys = lastDays(new Date(), SPAN[tab]);
    when.textContent = tab === "today" ? dayLabel(keys[0]) : `${dayLabel(keys[0], false)} – ${dayLabel(keys[keys.length - 1], false)}`;
    status.textContent = sum?.more ? "lendo o histórico…" : "";
    const msg = sum === undefined ? "Lendo os registros…" : sum === null ? "Disponível só no app."
      : !sum.days.length ? "Nenhum uso encontrado nos registros do Claude Code ou do Codex." : "";
    empty = !!msg;
    rows = 0;
    clear(panel);
    panel.append(...(sum && !empty ? content(sum, keys) : [h("div", { class: "aistats-none", text: msg })]));
    if (resize) ctx.onResize();
  };

  // Each call works up to 2 s in Rust; keep going while more is left and the view is still up.
  const load = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        sum = await AistatsBridge.refresh();
        draw();
        if (!sum?.more || !shown || ctx.api.island.mode() !== "expanded") break;
      }
    } finally { busy = false; }
  };
  draw(false);
  return {
    el,
    get height() { return fitHeight(tab, rows, empty); },
    // Nothing is read while the tab is hidden; one refresh each time it comes up.
    sync() {
      const on = ctx.api.island.view() === "aistats";
      if (on && !shown) void load();
      shown = on;
    },
  };
}
