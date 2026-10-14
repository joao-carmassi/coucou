// Integration events → island state: the module's pills, their news, the hooks it provides.
// Port of integrations.ts and the openTarget/followNews parts of island.ts at m3-ok.
// Polls are on the Rust side; this only listens (`integration`, `secrets-changed`).

import { Bridge, type GithubData, type IntegrationUpdate } from "../../core/bridge";
import type { Disposer, HomeRequest, IslandApi, TaskCard, TaskNews } from "../../core/moduleApi";
import { Sound } from "../../core/sound";
import { State, type AgentTask } from "../../core/state";
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
const WAITING = new Set(["approval", "question"]);

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
  let borrowedFrom: string | null = null;
  let owned = false;
  let detailOpen = false;
  let alive = true;

  const redraw = () => {
    State.notify();
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
      State.tasks = State.tasks.filter((t) => t.id !== id);
      delete info[id];
      steps.delete(id);
    } else if (want && !owned) {
      owned = true;
      const order = PROVIDERS.map((x) => x.id);
      // In catalog order, after Claude's pill and the agents.
      const at = State.tasks.findIndex((t) => order.indexOf(t.id) > order.indexOf(id));
      const task: AgentTask = { id, name: def.name, color: def.color, state: "idle" };
      State.tasks.splice(at < 0 ? State.tasks.length : at, 0, task);
      info[id] ??= empty(true);
      info[id].configured = true;
      steps.set(id, []);
      void Bridge.refreshIntegration(id);
    }
    if (!State.tasks.some((t) => t.id === State.focusId)) State.focusId = State.tasks[0]?.id ?? null;
    redraw();
  }

  async function refreshConfigured() {
    syncPill((await Bridge.secretPresent(def.key)) ?? false);
  }

  // ── News ───────────────────────────────────────────────────────────────────

  function giveBack() {
    const previous = borrowedFrom;
    borrowedFrom = null;
    if (previous && State.focusId === id && State.tasks.some((t) => t.id === previous)) State.focusId = previous;
  }

  /**
   * The pill's news is over: it got old, or it was opened, and news that was opened is not news any
   * more. Unless the user is being taken to what it was about (`stay`), the front goes back.
   */
  function settle(stay = false) {
    clearTimer?.();
    clearTimer = null;
    if (info[id]) info[id].news = null;
    api.pill.badge(id, null);
    if (stay) borrowedFrom = null;
    else giveBack();
    const task = State.tasks.find((t) => t.id === id);
    if (task && (task.state === "finished" || task.state === "error")) {
      task.state = "idle";
      steps.set(id, []);
    }
    State.notify();
  }

  /** Straight to what the news is about: from its card, from the panel's line, or from a click on Mochi. */
  function followNews(): boolean {
    const news = info[id]?.news;
    if (!news) return false;
    Sound.play("blip");
    enterGithubPanel(news.open);
    settle(true);
    api.island.setView("github");
    return true;
  }

  function handle(update: IntegrationUpdate) {
    if (State.paused || update.id !== id || !owned) return;
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
        isGithub && State.mode !== "expanded" && State.focusId !== update.id &&
        State.focusId && !(front && WAITING.has(front.state))
      ) {
        borrowedFrom ??= State.focusId;
        State.focusId = update.id;
        opened = true;
      }
      if (State.focusId !== id) api.pill.badge(id, event.success ? "finished" : "error");
      // A run the panel was showing when it ended has been played there already.
      const about = event.open?.target;
      const heard = about?.kind === "run" && sawRunEnd(about.id);
      if (!heard) Sound.play(event.success ? "finish" : "error");
      // Show the compact island so the news is seen, but never steal the screen for a successful
      // deploy. News that speaks up unfolds the island on its card instead; it folds back on its own.
      if (opened) api.island.open(event.success ? "finished" : "error");
      else api.island.wake();

      clearTimer?.();
      clearTimer = api.timeout(() => settle(), isGithub ? NEWS_MS : SETTLE_MS);
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

  function taskCard(taskId: string): TaskCard | null {
    const task = State.tasks.find((t) => t.id === taskId);
    if (taskId !== id || !task || !owned) return null;
    const own = info[id];
    const key = [id, detailOpen, task.state, steps.get(id)?.join("|"), own?.loaded, own?.error, own?.configured, JSON.stringify(own?.data ?? {})].join("~");
    return { key, build: () => renderIntegrationCard(task, cardHooks) };
  }

  function taskNews(taskId: string): TaskNews | null {
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
    if (id === "integration_n8n") void Bridge.openN8n();
    else if (isGithub && githubData()) void Bridge.openUrl(githubData()!.profileUrl);
    else if (def.url) void Bridge.openUrl(def.url);
    return true;
  }

  /** Without the Claude module there is no overview: the GitHub panel is home. */
  function homeView(): HomeRequest | null {
    return State.modules.claude !== true && owned ? { view: "github", pin: false, priority: 5 } : null;
  }

  const offs: Disposer[] = [
    // The open detail closes when the pill leaves the front.
    State.subscribe(() => {
      if (State.focusId !== id) detailOpen = false;
      // Focusing the pill is seeing its news: the badge goes (a repeat is a no-op).
      else if (State.tasks.find((t) => t.id === id)?.pillBadge) api.pill.badge(id, null);
    }),
    api.listen<IntegrationUpdate>("integration", handle),
    api.listen("secrets-changed", () => void refreshConfigured()),
    api.provide("openTarget", openTarget),
    api.provide("taskCard", taskCard),
    api.provide("taskNews", taskNews),
  ];
  if (isGithub) {
    offs.push(
      api.provide("followNews", followNews),
      api.provide("homeView", homeView),
      // The panel's own look for Mochi (a run going) lasts while the panel is on screen.
      State.subscribe(() => {
        if (State.mode !== "expanded" || State.view !== "github") api.avatar.publish(null);
      }),
    );
  }
  void refreshConfigured();

  return () => {
    alive = false;
    for (const off of offs.reverse()) off();
    giveBack();
    State.tasks = State.tasks.filter((t) => t.id !== id);
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
    if (!State.tasks.some((t) => t.id === State.focusId)) State.focusId = State.tasks[0]?.id ?? null;
    State.notify();
  };
}
