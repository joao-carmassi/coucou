// Integration events → island state: the module's pills, their news, the hooks it provides.
// Port of integrations.ts and the openTarget/followNews parts of island.ts at m3-ok.
// Polls are on the Rust side; this only listens (`integration`, `secrets-changed`).

import { App } from "../../kit/app";
import { type GithubData, type IntegrationUpdate, IntegrationsBridge } from "./bridge";
import type { Disposer, HomeRequest, IslandApi } from "../../core/moduleApi";
import type { BoardCard, BoardFocus, BoardNews } from "../board/api";
import { GITHUB, PROVIDERS, cleanups, info, rt, steps, type IntegrationInfo, type Provider } from "./store";
import { pillPresent } from "./providers";
import { renderIntegrationCard, githubData, type GithubOpening, type IntegrationCardHooks } from "./views/integrations";
import { enterGithubPanel, newsFacts, resetGithub, sawRunEnd } from "./views/github";

/** As in the Swift pollers: a pill's finished or error look clears itself after this. */
const SETTLE_MS = 60_000;
/**
 * News that speaks up stays longer: it is what tells of a build that broke, and someone away from
 * the screen for a minute must still find it there. Opening it ends it sooner.
 */
const NEWS_MS = 5 * 60_000;
/** States that are waiting for the user: nothing takes the front from those. */
const WAITING = new Set(["alert", "ask"]);

const empty = (configured: boolean): IntegrationInfo => ({ data: {}, error: null, loaded: false, configured });

/** One provider's run: its pill, its news, the hooks answering only for its own id. */
export function startProvider(api: IslandApi, def: Provider): Disposer {
  const id = def.id;
  const isGithub = id === GITHUB;
  if (isGithub) {
    rt.api = api;
    resetGithub();
  }

  let clearTimer: Disposer | null = null;
  /** The pill the news took the front from, to hand it back. */
  /** Gives the front back to the pill the news took it from (api.pills.focus). */
  let borrowedFrom: (() => void) | null = null;
  let owned = false;
  let detailOpen = false;
  let alive = true;

  const redraw = () => {
    api.island.redraw();
  };

  // ── Pill ───────────────────────────────────────────────────────────────────

  /** On while its module is on (we are running) AND its key is in the Credential Manager. */
  function syncPill(keyPresent: boolean) {
    if (!alive) return;
    const want = pillPresent(true, keyPresent);
    if (!want && owned) {
      owned = false;
      settle(true);
      api.pills.remove(id);
      delete info[id];
      steps.delete(id);
    } else if (want && !owned) {
      owned = true;
      const order = PROVIDERS.map((x) => x.id);
      // In catalog order, after Claude's pill and the agents.
      const next = api.pills.all().find((t) => order.indexOf(t.id) > order.indexOf(id));
      api.pills.set({ id, label: def.name, color: def.color, mood: "idle" }, next ? { before: next.id } : undefined);
      info[id] ??= empty(true);
      info[id].configured = true;
      steps.set(id, []);
      void IntegrationsBridge.refreshIntegration(id);
    }
    redraw();
  }

  async function refreshConfigured() {
    syncPill((await IntegrationsBridge.secretPresent(def.key)) ?? false);
  }

  // ── News ───────────────────────────────────────────────────────────────────

  function giveBack() {
    const release = borrowedFrom;
    borrowedFrom = null;
    release?.();
  }

  /**
   * The pill's news is over: it got old, or it was opened, and news that was opened is not news any
   * more. Unless the user is being taken to what it was about (`stay`), the front goes back.
   */
  function settle(stay = false) {
    clearTimer?.();
    clearTimer = null;
    if (info[id]) info[id].news = null;
    api.pills.set({ id, badge: null });
    if (stay) borrowedFrom = null;
    else giveBack();
    const task = api.pills.get(id);
    if (task && (task.mood === "done" || task.mood === "error")) {
      api.pills.set({ id, mood: "idle" });
      steps.set(id, []);
    }
    api.island.redraw();
  }

  /** Straight to what the news is about: from its card, from the panel's line, or from a click on Mochi. */
  function followNews(): boolean {
    const news = info[id]?.news;
    if (!news) return false;
    api.sound.play("blip");
    enterGithubPanel(news.open);
    settle(true);
    api.island.setView("github");
    return true;
  }

  function handle(update: IntegrationUpdate) {
    if (api.paused() || update.id !== id || !owned) return;
    const previous = info[update.id];
    // A failed poll carries no data and keeps what was there. GitHub's carries its last good
    // snapshot, so the panel can go on showing it next to the reason it isn't fresh.
    const hasData = Object.keys(update.data).length > 0;
    info[update.id] = {
      data: hasData ? update.data : (previous?.data ?? {}),
      error: update.error,
      loaded: hasData || (previous?.loaded ?? false),
      configured: previous?.configured ?? true,
      news: update.event ?? previous?.news ?? null,
    };

    // A run going on one of the projects: GitHub's Mochi is at work until it ends.
    if (isGithub && hasData) {
      const repos = (update.data as Partial<GithubData>).repos ?? [];
      const going = repos.some((r) => r.build?.state === "running");
      const task = api.pills.get(update.id);
      if (task && going && task.mood === "idle") api.pills.set({ id: update.id, mood: "working" });
      else if (task && !going && task.mood === "working") api.pills.set({ id: update.id, mood: "idle" });
    }

    const event = update.event;
    const task = event ? api.pills.get(update.id) : null;
    if (event && task) {
      api.pills.set({ id: update.id, mood: event.success ? "done" : "error" });
      steps.set(update.id, event.detail ? [event.label, event.detail] : [event.label]);
      // Only while the island is away or folded: open, it is showing something the user is reading.
      const front = api.pills.front();
      let opened = false;
      if (
        isGithub && api.island.mode() !== "expanded" && front?.id !== update.id &&
        front && !(front && WAITING.has(front.mood))
      ) {
        const release = api.pills.focus(update.id);
        borrowedFrom ??= release; // the first lender wins, as before
        opened = true;
      }
      if (api.pills.front()?.id !== id) api.pills.set({ id, badge: event.success ? "done" : "error" });
      // A run the panel was showing when it ended has been played there already.
      const about = event.open?.target;
      const heard = about?.kind === "run" && sawRunEnd(about.id);
      if (!heard) api.sound.play(event.success ? "finish" : "error");
      // Show the compact island so the news is seen, but never steal the screen for a successful
      // deploy. News that speaks up unfolds the island on its card instead; it folds back on its own.
      if (opened) api.island.open(event.success ? "finished" : "error");
      else api.island.wake();

      clearTimer?.();
      clearTimer = api.timeout(() => settle(), isGithub ? NEWS_MS : SETTLE_MS);
    }
    redraw();
  }

  // ── What the board and the result cards ask for ────────────────────────────

  const cardHooks: IntegrationCardHooks = {
    get detailOpen() { return detailOpen; },
    openDetail() { detailOpen = true; redraw(); },
    closeDetail() { detailOpen = false; redraw(); },
    openSettings: () => void App.openSettingsWindow(),
    // The card's figure asks for the panel as a whole: while the pill has news, that leads to it.
    openPanel(open?: GithubOpening) {
      if (!open && followNews()) return;
      api.sound.play("blip");
      enterGithubPanel(open);
      api.island.setView("github");
    },
  };

  function boardCard(taskId: string): BoardCard | null {
    const task = api.pills.get(taskId);
    if (taskId !== id || !task || !owned) return null;
    const own = info[id];
    const key = [id, detailOpen, task.mood, steps.get(id)?.join("|"), own?.loaded, own?.error, own?.configured, JSON.stringify(own?.data ?? {})].join("~");
    return { key, build: () => renderIntegrationCard(task, cardHooks), target: true };
  }

  function boardNews(taskId: string): BoardNews | null {
    const news = taskId === id && owned ? info[id]?.news : null;
    if (!news) return null;
    return {
      says: news.open?.says ?? (news.success ? "pull request mesclado" : "um build quebrou"),
      title: news.open?.title ?? news.label,
      facts: newsFacts(news),
    };
  }

  /** The ↗ button: same targets as openAgentTarget() on macOS. */
  function openTarget(taskId: string): boolean {
    if (taskId !== id || !owned) return false;
    if (id === "integration_n8n") void IntegrationsBridge.openN8n();
    else if (isGithub && githubData()) void App.openUrl(githubData()!.profileUrl);
    else if (def.url) void App.openUrl(def.url);
    return true;
  }

  /** Without the board there is no home tab: the GitHub panel is home. */
  function homeView(): HomeRequest | null {
    return api.use("board.host") === undefined && owned ? { view: "github", priority: 5 } : null;
  }

  const offs: Disposer[] = [
    // The open detail closes when the pill leaves the front.
    api.island.onChange(() => {
      if (api.pills.front()?.id !== id) detailOpen = false;
      // Focusing the pill is seeing its news: the badge goes (a repeat is a no-op).
      else if (api.pills.get(id)?.badge) api.pills.set({ id, badge: null });
    }),
    // The cards follow Pause (updates are dropped while paused).
    api.onPause(() => redraw()),
    api.listen<IntegrationUpdate>("integration", handle),
    api.listen("secrets-changed", () => void refreshConfigured()),
    api.provide("pillOpen", openTarget),
    api.provide("board.card", boardCard),
    api.provide("board.news", boardNews),
    // A click on this pill in the board's list (the board plays the blip).
    api.provide<BoardFocus>("board.focus", (taskId) => { if (taskId === id && owned) api.pills.focus(id); }),
  ];
  if (isGithub) {
    offs.push(
      api.provide("avatarClick", followNews),
      api.provide("homeView", homeView),
      // The panel's own look for Mochi (a run going) lasts while the panel is on screen.
      api.island.onChange(() => {
        if (api.island.mode() !== "expanded" || api.island.view() !== "github") api.avatar.publish(null);
      }),
    );
  }
  void refreshConfigured();

  return () => {
    alive = false;
    for (const off of offs.reverse()) off();
    giveBack();
    api.pills.remove(id);
    owned = false;
    delete info[id];
    steps.delete(id);
    if (isGithub) {
      for (const clean of [...cleanups]) clean();
      cleanups.clear();
      api.avatar.publish(null);
      api.avatar.tint(null);
      resetGithub();
      rt.api = null;
    }
    api.island.redraw();
  };
}
