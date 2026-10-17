import { h, clear } from "../../kit/dom";
import { card, view } from "../../kit/card";
import { App } from "../../kit/app";
import { ago, empty, right, rowOf, rowTitle } from "../../kit/list";
import type { ViewContext, ViewHost } from "../../core/moduleApi";
import type { Occurrence } from "./ics";
import { agenda, clock, currentEvent, dayLabel, nextEvent, untilText } from "./plan";

/** What the view needs of the module; the module fills it in start(). */
export interface CalUi {
  occs(now: number): Occurrence[];
  tz(): string;
  days(): number;
  /** Number of feeds + external events known: null until the first refresh answered. */
  empty(): boolean | null;
  error(): string | null;
  busy(): boolean;
  refresh(): void;
  /** Called on every sync while the view is open: the module arms its slow repaint (it calls `paint`). */
  arm(paint: () => void): void;
}

const MAX_LINES = 60; // a bound on the DOM; the list scrolls

function line(o: Occurrence, tz: string): HTMLElement {
  const join = o.link && h("button", { class: "link-btn text-link cal-join", text: "Entrar", onclick: () => void App.openUrl(o.link!) });
  return rowOf("div", { attrs: { title: o.location || undefined } }, rowTitle(o.summary), right(join, ago(o.allDay ? "dia todo" : clock(o.start, tz))));
}

/** The Agenda tab: the next event with its countdown, then today and the days ahead. */
export function buildCalendarView(ui: CalUi, ctx: ViewContext): ViewHost {
  const body = h("div", { class: "stack cal-body" });
  const el = view(card(null, body));
  let key = "";
  const paint = () => {
    const now = Date.now(), tz = ui.tz();
    const occs = ui.occs(now);
    const cur = currentEvent(occs, now), next = nextEvent(occs, now);
    const head = cur ? `${cur.summary} · até ${clock(cur.end, tz)}` : next ? `${next.summary} · ${untilText(next.start - now)}` : "";
    // The text of everything drawn: redraw only when it changed (a minute passing changes the countdown).
    const groups = agenda(occs, now, tz, ui.days());
    const k = JSON.stringify([head, groups.map((g) => [g.day, g.items.map((o) => o.key)]), ui.error(), ui.busy(), ui.empty(), clock(now, tz)]);
    if (k === key) return;
    key = k;
    clear(body);
    const foot = h("div", { class: "cal-foot" },
      h("button", { class: "link-btn text-link", text: ui.busy() ? "Atualizando…" : "Atualizar", onclick: () => ui.refresh() }),
      ui.error() && h("span", { class: "cal-err", text: ui.error()! }));
    if (ui.empty() === true) {
      body.append(h("div", { class: "title", text: "Agenda" }),
        h("div", { class: "sub", text: "Cole o link ICS do seu calendário em Configurações > Calendário." }),
        h("div", { class: "actions" }, h("button", { class: "link-btn text-link", text: "Abrir configurações", onclick: () => void App.openSettingsWindow() })));
      return;
    }
    const list = h("div", { class: "cal-list scroll" });
    let lines = 0;
    for (const g of groups) {
      if (lines + 2 > MAX_LINES) break;
      list.append(h("div", { class: "cal-day", text: dayLabel(g.day, now, tz) }));
      lines++;
      for (const o of g.items) {
        if (lines >= MAX_LINES) break;
        list.append(line(o, tz));
        lines++;
      }
    }
    if (!groups.length) list.append(empty(ui.empty() === null ? "Carregando…" : `Nada nos próximos ${ui.days()} dias.`));
    body.append(h("div", { class: "title", text: "Agenda" }), h("div", { class: "cal-next", text: head }), list, foot);
  };
  return {
    el,
    sync() {
      if (ctx.api.island.view() !== "calendar") return;
      ui.arm(paint);
      paint();
    },
  };
}
