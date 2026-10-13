// Integration events → island state: the module's pills, their news, the hooks it provides.
// Port of integrations.ts and the openTarget/followNews parts of island.ts at m3-ok.
// Polls are on the Rust side; this only listens (`integration`, `secrets-changed`).

import { Bridge, type GithubData, type IntegrationUpdate } from "../../core/bridge";
import type { Disposer, HomeRequest, IslandApi, TaskCard, TaskNews } from "../../core/moduleApi";
import { Sound } from "../../core/sound";
import { State, type AgentTask } from "../../core/state";
import {
  GITHUB, PROVIDERS, cleanups, info, integrationSettings, providerOf, resetStore, rt, steps, type IntegrationInfo,
} from "./store";
import { renderIntegrationCard, githubData, type GithubOpening, type IntegrationCardHooks } from "./views/integrations";
import { enterGithubPanel, newsFacts, resetGithub, sawRunEnd } from "./views/github";

/** As in the Swift pollers: a pill's finished or error look clears itself after this. */
const SETTLE_MS = 60_000;
/**
 * News that speaks up stays longer: it is what tells of a build that broke, and someone away from
 * the screen for a minute must still find it there. Opening it ends it sooner.
 */
const NEWS_MS = 5 * 60_000;
/** Integrations whose news opens the island, as a Claude Code session's result does. */
const SPEAKS_UP = new Set([GITHUB]);
/** States that are waiting for the user: nothing takes the front from those. */
const WAITING = new Set(["approval", "question"]);

const empty = (configured: boolean): IntegrationInfo => ({ data: {}, error: null, loaded: false, configured });

export function startIntegrations(api: IslandApi): Disposer {
  rt.api = api;
  resetStore();
  resetGithub();

  const clearTimers = new Map<string, Disposer>();
  /** The pill each news took the front from, to hand it back. */
  const borrowedFrom = new Map<string, string>();
  const configured: Record<string, boolean> = {};
  /** Pills this run of the module put among the tasks. */
  const owned = new Set<string>();
  let detailOpen = false;
  let detailFor: string | null = null;
  let alive = true;

  const redraw = () => {
    State.notify();
    api.island.redraw();
  };

  // ── Pills ──────────────────────────────────────────────────────────────────

  /** Active = switched on in Settings AND configured (its key is in the Credential Manager). */
  function wanted(): string[] {
    const on = new Set(integrationSettings().activeIntegrations);
    return PROVIDERS.filter((p) => on.has(p.id) && configured[p.id]).map((p) => p.id);
  }

  function syncPills() {
    if (!alive) return;
    const want = new Set(wanted());
    for (const id of [...owned]) {
      if (want.has(id)) continue;
      owned.delete(id);
      settle(id, true);
      State.tasks = State.tasks.filter((t) => t.id !== id);
      delete info[id];
      steps.delete(id);
    }
    const order = PROVIDERS.map((x) => x.id);
    for (const p of PROVIDERS) {
      if (!want.has(p.id) || owned.has(p.id)) continue;
      owned.add(p.id);
      // In declaration order, after Claude's pill and the agents, as at m3-ok.
      const at = State.tasks.findIndex((t) => order.indexOf(t.id) > order.indexOf(p.id));
      const task: AgentTask = { id: p.id, name: p.name, color: p.color, state: "idle" };
      State.tasks.splice(at < 0 ? State.tasks.length : at, 0, task);
      info[p.id] ??= empty(true);
      info[p.id].configured = true;
      steps.set(p.id, []);
      void Bridge.refreshIntegration(p.id);
    }
    if (!State.tasks.some((t) => t.id === State.focusId)) State.focusId = State.tasks[0]?.id ?? null;
    redraw();
  }

  /** Asks Rust which keys exist: only a configured integration gets a pill. */
  async function refreshConfigured() {
    for (const p of PROVIDERS) configured[p.id] = (await Bridge.secretPresent(p.key)) ?? false;
    syncPills();
  }

  // ── News ───────────────────────────────────────────────────────────────────

  function giveBack(id: string) {
    const previous = borrowedFrom.get(id);
    borrowedFrom.delete(id);
    if (previous && State.focusId === id && State.tasks.some((t) => t.id === previous)) State.focusId = previous;
  }

  /**
   * A pill's news is over: it got old, or it was opened, and news that was opened is not news any
   * more. Unless the user is being taken to what it was about (`stay`), the front goes back.
   */
  function settle(id: string, stay = false) {
    clearTimers.get(id)?.();
    clearTimers.delete(id);
    if (info[id]) info[id].news = null;
    if (stay) borrowedFrom.delete(id);
    else giveBack(id);
    const task = State.tasks.find((t) => t.id === id);
    if (task && (task.state === "finished" || task.state === "error")) {
      task.state = "idle";
      steps.set(id, []);
    }
    State.notify();
  }

  /** The pill whose news the user is looking at: the one at the front, else GitHub's. */
  function newsId(): string | null {
    const telling = (id: string | null) => id != null && SPEAKS_UP.has(id) && info[id]?.news != null;
    return telling(State.focusId) ? State.focusId : telling(GITHUB) ? GITHUB : null;
  }

  /** Straight to what the news is about: from its card, from the panel's line, or from a click on Mochi. */
  function followNews(): boolean {
    const id = newsId();
    const news = id ? info[id]?.news : null;
    if (!id || !news) return false;
    Sound.play("blip");
    enterGithubPanel(news.open);
    settle(id, true);
    api.island.setView("github");
    return true;
  }

  function handle(update: IntegrationUpdate) {
    if (State.paused || !owned.has(update.id)) return;
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
    if (update.id === GITHUB && hasData) {
      const repos = (update.data as Partial<GithubData>).repos ?? [];
      const going = repos.some((r) => r.build?.state === "running");
      const task = State.tasks.find((t) => t.id === update.id);
      if (task && going && task.state === "idle") task.state = "working";
      else if (task && !going && task.state === "working") task.state = "idle";
    }

    const event = update.event;
    const task = event ? State.tasks.find((t) => t.id === update.id) : null;
    if (event && task) {
      task.state = event.success ? "finished" : "error";
      steps.set(update.id, event.detail ? [event.label, event.detail] : [event.label]);
      // Only while the island is away or folded: open, it is showing something the user is reading.
      const front = State.focusTask;
      let opened = false;
      if (
        SPEAKS_UP.has(update.id) && State.mode !== "expanded" && State.focusId !== update.id &&
        State.focusId && !(front && WAITING.has(front.state))
      ) {
        if (!borrowedFrom.has(update.id)) borrowedFrom.set(update.id, State.focusId);
        State.focusId = update.id;
        opened = true;
      }
      // A run the panel was showing when it ended has been played there already.
      const about = event.open?.target;
      const heard = about?.kind === "run" && sawRunEnd(about.id);
      if (!heard) Sound.play(event.success ? "finish" : "error");
      // Show the compact island so the news is seen, but never steal the screen for a successful
      // deploy. News that speaks up unfolds the island on its card instead; it folds back on its own.
      if (opened) api.island.open(event.success ? "finished" : "error");
      else api.island.wake();

      clearTimers.get(update.id)?.();
      clearTimers.set(update.id, api.timeout(() => settle(update.id), SPEAKS_UP.has(update.id) ? NEWS_MS : SETTLE_MS));
    }
    redraw();
  }

  // ── What the Claude overview and its cards ask for ─────────────────────────

  const cardHooks: IntegrationCardHooks = {
    get detailOpen() { return detailOpen; },
    openDetail() { detailOpen = true; redraw(); },
    closeDetail() { detailOpen = false; redraw(); },
    openSettings: () => void Bridge.openSettingsWindow(),
    // The card's figure asks for the panel as a whole: while the pill has news, that leads to it.
    openPanel(open?: GithubOpening) {
      if (!open && followNews()) return;
      Sound.play("blip");
      enterGithubPanel(open);
      api.island.setView("github");
    },
  };

  function taskCard(id: string): TaskCard | null {
    const task = State.tasks.find((t) => t.id === id);
    if (!task || !owned.has(id)) return null;
    // The detail of a card belongs to the pill in front: another pill starts closed.
    if (detailFor !== id) { detailFor = id; detailOpen = false; }
    const own = info[id];
    const key = [id, detailOpen, task.state, steps.get(id)?.join("|"), own?.loaded, own?.error, own?.configured, JSON.stringify(own?.data ?? {})].join("~");
    return { key, build: () => renderIntegrationCard(task, cardHooks) };
  }

  function taskNews(id: string): TaskNews | null {
    const news = owned.has(id) ? info[id]?.news : null;
    if (!news) return null;
    return {
      says: news.open?.says ?? (news.success ? "pull request mesclado" : "um build quebrou"),
      title: news.open?.title ?? news.label,
      facts: newsFacts(news),
    };
  }

  /** The ↗ button: same targets as openAgentTarget() on macOS. */
  function openTarget(id: string): boolean {
    const p = providerOf(id);
    if (!p || !owned.has(id)) return false;
    if (id === "integration_n8n") void Bridge.openN8n();
    else if (id === GITHUB && githubData()) void Bridge.openUrl(githubData()!.profileUrl);
    else if (p.url) void Bridge.openUrl(p.url);
    return true;
  }

  /** Without the Claude module there is no overview: the GitHub panel is home. */
  function homeView(): HomeRequest | null {
    return State.modules.claude !== true && owned.has(GITHUB) ? { view: "github", pin: false, priority: 5 } : null;
  }

  const offs: Disposer[] = [
    api.listen<IntegrationUpdate>("integration", handle),
    api.listen("secrets-changed", () => void refreshConfigured()),
    // After the core has taken the new settings in (its own listener may run second).
    api.listen("settings-changed", () => void api.timeout(syncPills, 0)),
    api.provide("openTarget", openTarget),
    api.provide("followNews", followNews),
    api.provide("taskCard", taskCard),
    api.provide("taskNews", taskNews),
    api.provide("homeView", homeView),
    // The panel's own look for Mochi (a run going) lasts while the panel is on screen.
    State.subscribe(() => {
      if (State.mode !== "expanded" || State.view !== "github") api.avatar.publish(null);
    }),
  ];
  void refreshConfigured();

  return () => {
    alive = false;
    for (const off of offs.reverse()) off();
    for (const clean of [...cleanups]) clean();
    cleanups.clear();
    api.avatar.publish(null);
    api.avatar.tint(null);
    for (const id of [...borrowedFrom.keys()]) giveBack(id);
    State.tasks = State.tasks.filter((t) => !owned.has(t.id));
    owned.clear();
    if (!State.tasks.some((t) => t.id === State.focusId)) State.focusId = State.tasks[0]?.id ?? null;
    resetGithub();
    resetStore();
    rt.api = null;
    State.notify();
  };
}
