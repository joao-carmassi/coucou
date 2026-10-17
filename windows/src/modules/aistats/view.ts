// Estatísticas de IA view: tiles, 7-day bars, top models and projects. Reads logs only while it is on screen.
import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import { AistatsBridge } from "./bridge";
import { costTotal, fmtTokens, fmtUsd, PRICES_DATE, sumOf, weekBars, type Summary } from "./logic";

export function buildView(ctx: ViewContext): ViewHost {
  const body = h("div", { class: "stack scroll aistats-view" });
  body.style.padding = "14px 12px 14px 84px";
  const el = view(card(null, body));
  let busy = false;
  let shown = false;

  const row = (label: string, value: string) => h("div", { class: "aistats-row" }, h("span", { text: label }), h("span", { text: value }));
  const refreshBtn = () => h("div", { class: "actions" }, h("div", { class: "grow" }),
    h("button", { class: "link-btn text-link", text: "Atualizar", onclick: () => void load() }));

  const draw = (s: Summary | null) => {
    clear(body);
    if (!s || !s.days.length) {
      body.append(h("div", { class: "sub", text: s ? "Nenhum uso encontrado nos registros do Claude Code ou do Codex." : "Disponível só no app." }), refreshBtn());
      ctx.onResize();
      return;
    }
    const cost = costTotal(s.models);
    const bars = weekBars(s.days, new Date());
    const tile = (label: string, v: string) => h("div", { class: "aistats-tile" }, h("b", { text: v }), h("span", { text: label }));
    body.append(
      h("div", { class: "title", text: "Estatísticas de IA (30 dias)" }),
      h("div", { class: "aistats-tiles" },
        tile("entrada", fmtTokens(s.total.input)), tile("saída", fmtTokens(s.total.output)),
        tile("cache", fmtTokens(s.total.cache_read + s.total.cache_write)),
        tile(cost.partial ? "custo (parcial)" : "custo", fmtUsd(cost.usd))),
      h("div", { class: "aistats-days" }, ...bars.map((b) => {
        const bar = h("i", { title: `${b.day}: ${fmtTokens(b.tokens)}` });
        bar.style.height = `${b.pct}%`;
        return h("div", { class: "aistats-day" }, bar, h("span", { text: new Date(`${b.day}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "") }));
      })),
      h("div", { class: "sub", text: "Modelos" }),
      ...s.models.slice(0, 5).map(([m, t]) => row(m, fmtTokens(sumOf(t)))),
      ...(s.projects.length ? [h("div", { class: "sub", text: "Projetos" }), ...s.projects.map(([p, n]) => row(p, fmtTokens(n)))] : []),
      h("div", { class: "sub", text: `Custo é estimativa (tabela de ${PRICES_DATE}); modelo sem preço não entra.${s.approx ? " Algum registro foi reescrito: números aproximados." : ""}${s.more ? " Lendo o histórico…" : ""}` }),
      refreshBtn(),
    );
    ctx.onResize();
  };

  // Each call works up to 2 s in Rust; keep going while more is left and the view is still up.
  const load = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const s = await AistatsBridge.refresh();
        draw(s);
        if (!s?.more || !shown) break;
      }
    } finally { busy = false; }
  };
  return {
    el,
    // Nothing is read while the tab is hidden; one refresh each time it comes up.
    sync() {
      const on = ctx.api.island.view() === "aistats";
      if (on && !shown) void load();
      shown = on;
    },
  };
}
