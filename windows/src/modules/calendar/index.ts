// Calendário: ICS feeds (secret URLs kept by Rust) -> events in memory -> the Agenda tab and one reminder notice.
// Nothing runs while the module is off. Network: only when the island is visible (wake / one slow interval) or on a click.
// The reminder is ONE api.timeout for the next event, re-armed after it fires or after a refresh; no polling.
import "./calendar.css";
import { BAND, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { CALENDAR_SERVICE, type CalendarSource, type CalendarSourceEvent } from "./api";
import { CalendarBridge } from "./bridge";
import { ICON_CALENDAR } from "./icons";
import { parseIcs } from "./ics";
import { nextReminder, untilText } from "./plan";
import { CalendarStore } from "./store";
import { buildCalendarView, type CalUi } from "./view";

interface Cfg { calendarRemindMin: number; calendarDaysAhead: number }

/** Never refresh sooner than this (the user's own click aside). */
export const MIN_REFRESH_MS = 15 * 60_000;
const MAX_TIMEOUT = 2 ** 31 - 1;
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// The view is built when the module registers, before start(): it talks to whatever is live.
let live: CalUi | null = null;
const idle: CalUi = { occs: () => [], tz: () => "UTC", days: () => 7, empty: () => null, error: () => null, busy: () => false, refresh() {}, arm() {} };
const now = (): CalUi => live ?? idle;
const view: CalUi = {
  occs: (t) => now().occs(t), tz: () => now().tz(), days: () => now().days(), empty: () => now().empty(),
  error: () => now().error(), busy: () => now().busy(), refresh: () => now().refresh(), arm: (p) => now().arm(p),
};

function start(api: IslandApi): Disposer {
  const store = new CalendarStore();
  const done = new Set<string>(); // reminders already shown
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cfg = () => {
    const s = api.settings<Cfg>();
    return { lead: clamp(s.calendarRemindMin, 0, 120, 10), days: clamp(s.calendarDaysAhead, 1, 30, 7) };
  };
  let dead = false, busy = false, last = 0, error: string | null = null, feeds: number | null = null, extCount = 0;
  let reminder: Disposer | null = null, tick: Disposer | null = null, paintNow: (() => void) | null = null;

  const rearm = () => {
    reminder?.();
    reminder = null;
    if (dead) return;
    const t0 = Date.now(), { lead, days } = cfg();
    for (const k of done) if (Number(k.slice(k.lastIndexOf("@") + 1)) < t0 - 86_400_000) done.delete(k);
    const next = nextReminder(store.occs(t0, zone(), days), t0, lead, done);
    if (!next) return;
    reminder = api.timeout(() => {
      reminder = null;
      const t = Date.now();
      if (t < next.at - 1000) return rearm(); // fired early (the clock moved)
      done.add(next.occ.key);
      // A request waiting keeps the island: the notice would queue behind it anyway.
      if (!api.island.busy()) api.island.notice({ text: `${next.occ.summary} começa ${untilText(next.occ.start - t)}`, priority: BAND.NOTICE, view: "calendar", key: "reminder", ms: 10_000, peek: true });
      rearm();
    }, Math.min(MAX_TIMEOUT, Math.max(0, next.at - t0)));
  };

  const refresh = async (force: boolean) => {
    if (busy || dead || (!force && Date.now() - last < MIN_REFRESH_MS - 5000)) return;
    busy = true;
    error = null;
    paintNow?.();
    try {
      const list = await CalendarBridge.list();
      feeds = list.length;
      store.keep(list.map((f) => f.slot));
      for (const f of list) {
        try {
          const r = await CalendarBridge.fetch(f.slot, store.has(f.slot));
          if (!r.notModified) store.set(f.slot, parseIcs(r.body, zone()));
        } catch (e) {
          error = typeof e === "string" ? e : "Não foi possível ler o calendário.";
        }
      }
      const ext: CalendarSourceEvent[] = [];
      for (const src of api.useAll<CalendarSource>(CALENDAR_SERVICE.source)) {
        try { ext.push(...(await src())); } catch { /* a provider failing must not hide the feeds */ }
      }
      store.setExternal(ext);
      extCount = ext.length;
    } catch (e) {
      error = typeof e === "string" ? e : "Não foi possível ler o calendário.";
    } finally {
      busy = false;
      last = Date.now();
      if (!dead) { rearm(); api.island.redraw(); paintNow?.(); }
    }
  };

  live = {
    occs: (t) => store.occs(t, zone(), cfg().days),
    tz: zone,
    days: () => cfg().days,
    empty: () => (feeds === null ? null : feeds === 0 && extCount === 0),
    error: () => error,
    busy: () => busy,
    refresh: () => void refresh(true),
    // Repaints the countdown every 30 s while the view is open and the island visible; disarms itself when it is left.
    arm(paint) {
      paintNow = paint;
      if (tick) return;
      tick = api.interval(() => {
        if (api.island.view() === "calendar" && api.island.mode() === "expanded") paint();
        else { tick?.(); tick = null; }
      }, 30_000, { whenVisible: true });
    },
  };

  const offVis = api.onVisibility((mode) => {
    if (mode === "hidden") return;
    void refresh(false);
    rearm(); // the reminder setting may have changed
  });
  const offSlow = api.interval(() => void refresh(false), MIN_REFRESH_MS, { whenVisible: true });
  const offChanged = api.listen("calendar-changed", () => void refresh(true));
  // Reminder lead / days changed: re-arm and repaint. Deferred so api.settings() already holds the new values.
  let later: Disposer | null = null;
  const offSettings = api.listen("settings-changed", () => {
    later?.();
    later = api.timeout(() => { later = null; rearm(); api.island.redraw(); paintNow?.(); }, 0);
  });
  if (api.island.mode() !== "hidden") void refresh(false);

  return () => {
    dead = true;
    reminder?.(); tick?.(); offVis(); offSlow(); offChanged(); offSettings(); later?.();
    store.clear();
    done.clear();
    live = null;
  };
}

export const calendarModule: ModuleDef = {
  id: "calendar",
  views: [{
    name: "calendar",
    layout: { height: 250, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildCalendarView(view, ctx),
  }],
  tabs: [{ view: "calendar", title: "Agenda", icon: () => svg(ICON_CALENDAR, 13), order: 36 }],
  start,
};
