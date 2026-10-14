// The Claude module's controller: what the island's code did for Claude Code sessions at m3-ok
// (settleRequest, afterRequest, pickSession, goToAlert, openClient, decide, answer, ...), now
// working through the module API. One instance per module start; views reach it with claudeOf().

import { CLAUDE_SERVICE, type LaunchFile, type LaunchPrompt } from "./api";
import { App } from "../../kit/app";
import { ClaudeBridge } from "./bridge";
import type { BotStateName } from "../../core/layout";
import type { Disposer, IslandApi } from "../../core/moduleApi";
import { activityLine } from "./activity";
import { handleHook, type HookPayload } from "./hooks";
import { ClaudeStore } from "./store";
import { enterSessionPanel } from "./views/session";
import {
  CLAUDE_COLOR, CLAUDE_ID, QUESTION_TOOL,
  type SessionStep,
} from "./types";

/** A session at work is presumed dead after this long without a word. */
const STALE_MS = 15 * 60_000;
/** Pills whose ↗ opens something (the others' would do nothing). */
const TARGETED = new Set([
  CLAUDE_ID, "integration_n8n", "integration_github", "integration_resend",
  "integration_vercel", "integration_stripe", "integration_notion", "integration_calcom",
]);
export const hasTarget = (id: string | undefined) => !!id && TARGETED.has(id);

const instances = new WeakMap<IslandApi, Claude>();

/** The controller of the module run `api` belongs to. */
export function claudeOf(api: IslandApi): Claude {
  let c = instances.get(api);
  if (!c) instances.set(api, (c = new Claude(api)));
  return c;
}

export class Claude {
  readonly store: ClaudeStore;
  /** Per session: the timer that gives up on its request (see PENDING_MS in hooks.ts). */
  readonly pending = new Map<string, Disposer>();

  constructor(readonly api: IslandApi) {
    this.store = new ClaudeStore(api);
  }

  /** Claude's pill and the third-party agents it follows are its own; the board asks it about them. */
  owns(id: string): boolean {
    return id === CLAUDE_ID || this.store.agentSteps.has(id);
  }

  /** The pill in front. */
  focusId(): string | null {
    return this.api.pills.front()?.id ?? null;
  }

  private redraw = () => this.api.island.redraw();

  // ── Pill and third-party agents ───────────────────────────────────────────

  setFocus(id: string) {
    this.api.pills.focus(id);
    this.store.badges.delete(id);
    this.store.changed();
  }

  upsertAgent(id: string, name: string, color: string) {
    if (this.api.pills.get(id)) return;
    // Right after the Claude pill, so it is among the first four.
    this.api.pills.set({ id, label: name, color, mood: "idle" }, { after: CLAUDE_ID });
    this.store.agentSteps.set(id, []);
    this.store.changed();
  }

  updateTask(id: string, state: BotStateName) {
    this.api.pills.set({ id, mood: state });
    this.store.changed();
  }

  appendStep(id: string, step: string) {
    const steps = this.store.agentSteps.get(id);
    if (!steps) return;
    steps.push(step);
    if (steps.length > 20) steps.shift();
    this.store.changed();
  }

  removeAgent(id: string) {
    if (!this.api.pills.get(id)) return;
    this.api.pills.remove(id);
    this.store.agentSteps.delete(id);
    this.store.badges.delete(id);
    this.store.changed();
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /** Alert: the island opens on this view, whatever it was doing. Pinned alerts never auto-close. */
  alert(view: string) {
    this.api.island.open(view);
  }

  /** The core request of the card in front (approval 100, question 90), pinned. */
  private asked: { view: string; off: Disposer } | null = null;

  /**
   * Keeps ONE core request in step with what the session in front waits for; it goes when nothing waits.
   * `show`: the island opens on the card; otherwise it is only queued (and pinned), the screen is not taken.
   * The core owns the pin, so another module's request is never touched.
   */
  syncRequest(show: boolean) {
    const { pendingApproval, pendingQuestion } = this.store;
    const view = pendingApproval ? "approval" : pendingQuestion ? "question" : null;
    if (view === (this.asked?.view ?? null)) {
      if (view && show) this.api.island.open(view);
      return;
    }
    const prev = this.asked;
    this.asked = view ? { view, off: this.api.island.request({ view, priority: view === "approval" ? 100 : 90, pin: true, quiet: !show }) } : null;
    prev?.off();
  }

  /** A pill of the board's list was clicked (the board plays the blip): it comes to the front; Claude's pill brings its pending card with it. */
  focusPill(id: string) {
    this.setFocus(id);
    // A request that came in while another pill had the front only left a
    // badge: bringing Claude's pill forward is asking for its card.
    // Folded: side-effect free (setView/afterRequest could open the island); the next open shows the card anyway.
    if (id !== CLAUDE_ID || this.api.island.mode() !== "expanded") return;
    if (this.store.pendingQuestion) this.api.island.setView("question");
    else if (this.store.pendingApproval) this.api.island.setView("approval");
    // No card for the session in front, but one behind it is waiting: its turn.
    else if (this.store.waiting.length > 0) this.afterRequest(true);
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  /** Writes what was decided on the island in the journal, on the step that was waiting for it. */
  private noteOutcome(tool: string, write: (step: SessionStep) => void) {
    const step = [...this.store.session.steps].reverse().find((s) => s.tool === tool && s.state === "running");
    if (step) write(step);
  }

  /** The request on the card got its answer: its session is back at work. */
  private settleRequest() {
    const session = this.store.session;
    session.approval = null;
    session.question = null;
    session.state = "working";
    this.afterRequest(true);
  }

  /**
   * The request of the session in front is done with. Another session waiting
   * for an answer comes forward with its own; with none, the island is free
   * to close again. `show` moves the view too: to that card, or back to the
   * overview.
   */
  afterRequest(show: boolean) {
    const store = this.store;
    const next = store.pendingApproval || store.pendingQuestion ? store.session : store.waiting[0];
    if (next) store.bringForward(next.id);
    store.setBadge(CLAUDE_ID, next && this.focusId() !== CLAUDE_ID ? "alert" : null);
    store.present();
    if (show) {
      this.syncRequest(true);
      if (!next) this.api.island.open(this.api.island.home());
    } else this.syncRequest(false);
  }

  decide(d: "allow" | "deny" | "plan-keep" | "plan-manual" | "plan-auto") {
    const req = this.store.pendingApproval;
    void App.log(`decide ${d} req=${req?.requestId ?? "none"}`);
    if (!req) return;
    const denied = d === "deny" || d === "plan-keep";
    this.api.sound.play(denied ? "blip" : "approve");
    void ClaudeBridge.approvalDecision(req.requestId, d);
    this.noteOutcome(req.tool, (step) => (step.permission = denied ? "denied" : "allowed"));
    this.settleRequest();
  }

  answer(answers: Record<string, string>) {
    const req = this.store.pendingQuestion;
    if (!req) return;
    this.api.sound.play("approve");
    void ClaudeBridge.approvalAnswer(req.requestId, answers);
    this.noteOutcome(QUESTION_TOOL, (step) => (step.answers = answers));
    this.settleRequest();
  }

  skipQuestion() {
    const req = this.store.pendingQuestion;
    if (!req) return;
    this.api.sound.play("blip");
    void ClaudeBridge.approvalDecision(req.requestId, "skip");
    this.noteOutcome(QUESTION_TOOL, (step) => (step.state = "failed"));
    this.settleRequest();
  }

  /** Leaves the question on the card to Claude Code's own window. */
  passQuestion() {
    const req = this.store.pendingQuestion;
    if (!req) return;
    this.api.sound.play("blip");
    // Declined, not denied: Claude Code asks it in its own window at once.
    void ClaudeBridge.approvalDecline(req.requestId);
    this.settleRequest();
  }

  // shortcut: relay gives up after ~108 s, then the terminal takes over
  /** "Aguardar": closes the island and leaves the request as it is: no decision is sent. */
  deferAlert() {
    this.api.island.close();
  }

  /**
   * Puts another session in front, at the user's asking: its card if it is
   * waiting for an answer, and never the card of the one that was there.
   */
  pickSession(id: string) {
    const store = this.store;
    if (id === store.frontId) return;
    this.api.sound.play("blip");
    // The list of sessions is reached whatever pill is in front: picking one is asking for Claude's.
    if (this.focusId() !== CLAUDE_ID) this.setFocus(CLAUDE_ID);
    store.bringForward(id);
    const session = store.session;
    const waits = session.question != null || session.approval != null;
    if (waits) {
      this.syncRequest(true);
    } else {
      this.syncRequest(false);
      const view = this.api.island.view();
      if (view === "approval" || view === "question") this.api.island.setView(this.api.island.home());
    }
  }

  /** Hotkey: straight to the card waiting for an answer (or home). */
  goToAlert() {
    if (this.focusId() !== CLAUDE_ID) this.setFocus(CLAUDE_ID);
    if (this.store.hasPending()) this.afterRequest(true);
    else if (this.api.island.mode() !== "expanded") this.api.island.reopen(); // lands on a held task, else home
    else this.api.island.open(this.api.island.home());
  }

  /** Where the session runs: the Claude app brought forward, or its terminal (VS Code without WSL). */
  openClient() {
    const s = this.store.session;
    if (s.client === "desktop") void ClaudeBridge.openClaudeApp();
    else void ClaudeBridge.openTerminal(s.cwd, s.wslDistro, s.terminalPids);
    // The window is in front now: fold the island back.
    this.api.island.close();
  }

  /** Into the session panel: its journal, or with `changes` straight to the files changed. */
  openSession(changes?: boolean) {
    enterSessionPanel(changes ? "changes" : "journal");
    this.api.island.setView("session");
  }

  /** Into the session panel, on the list of the sessions followed. */
  openSessions() {
    enterSessionPanel("sessions");
    this.api.island.setView("session");
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  showError(err: unknown) {
    this.api.island.note(String(err).replace(/^Error:\s*/, ""));
    this.api.sound.play("error");
  }

  /** A new terminal session, in the front session's profile and folder, with the file attached. */
  launchWith(path: string) {
    const front = this.store.session;
    // Shown at once: it also takes the choose card down, so a second click can't launch twice.
    this.api.island.note("Abrindo no terminal…");
    ClaudeBridge.sessionLaunch({ profile: front.profile, cwd: front.cwd, resume: null, attach: path })
      .then(() => this.api.sound.play("attach"))
      .catch((err) => this.showError(err));
  }

  /** `ingest`: the file is copied into the inbox first (the only place a session may attach from). */
  async launchFile(path: string, ingest: boolean) {
    try {
      if (ingest) {
        this.api.island.note("Abrindo no terminal…");
        path = (await App.inboxIngest(path)).path;
      }
      this.launchWith(path);
    } catch (err) {
      this.showError(err);
    }
  }

  // ── What the core shows of us ─────────────────────────────────────────────

  /** Status line and avatar: the only things pushed into the core besides the pill. */
  publish() {
    const s = this.store.session;
    const line = activityLine(s.id ? s : undefined);
    const priority = s.approval ? 100 : s.question ? 90 : line === "pronto" ? 60 : 30;
    this.api.status.set(line ? { text: line, priority, urgent: !!(s.approval || s.question) } : null);
    // The avatar wears the session in front while Claude's pill is the one in front.
    const worn = s.id && this.focusId() === CLAUDE_ID && s.state !== "idle" && s.state !== "sleeping";
    this.api.avatar.publish(worn ? { state: s.state, priority: s.approval || s.question ? 100 : 30 } : null);
  }

  private awake(): boolean {
    // A session at work keeps the compact island up; one silent for 15 min is presumed dead.
    // So does a request waiting for an answer.
    return this.store.hasPending() || this.store.sessions.some(
      (s) => (s.state === "working" || s.state === "thinking") && Date.now() - s.heardAt < STALE_MS,
    );
  }

  start(): Disposer {
    const { api, store } = this;
    api.pills.set({ id: CLAUDE_ID, label: store.clientName, color: CLAUDE_COLOR, mood: "idle" }, "start");

    const offs: Disposer[] = [
      store.subscribe(() => {
        this.publish();
        this.redraw();
      }),
      api.listen<HookPayload>("hook", (payload) => handleHook(this, payload)),
      // Hotkey (Rust): straight to the card waiting for an answer.
      api.listen<null>("go-to-alert", () => this.goToAlert()),
      // The idle card's button and the pill's name follow Settings.
      // (after the core has taken the new settings in: its own listener may run second)
      api.listen("settings-changed", () => void api.timeout(() => store.present(), 0)),
      api.provide("keepAwake", () => this.awake()),
      api.provide("pillOpen", (id) => id === CLAUDE_ID && (this.openClient(), true)),
      api.provide<LaunchFile>(CLAUDE_SERVICE.launchFile, (path, ingest) => this.launchFile(path, ingest)),
      api.provide<LaunchPrompt>(CLAUDE_SERVICE.launchPrompt, async (prompt) => {
        const profiles = (await ClaudeBridge.claudeProfiles()) ?? [];
        const profile = (profiles.find((p) => p.isDefault) ?? profiles[0])?.key ?? "";
        await ClaudeBridge.sessionLaunch({ profile, cwd: null, resume: null, attach: null, prompt });
      }),
      // Focus can change under us (another module's pill): keep the avatar in step.
      api.island.onChange(() => this.publish()),
      onKeys(this),
    ];
    this.publish();
    this.redraw();

    return () => {
      for (const off of offs.reverse()) off();
      // A request nobody can answer any more goes back to the terminal.
      for (const s of store.sessions) {
        const req = (s.approval ?? s.question)?.requestId;
        if (req) void ClaudeBridge.approvalDecline(req);
      }
      this.asked = null; // its request goes with the module scope
      // The pills (Claude's and the agents') go with the module: the registry clears them.
      this.pending.clear();
    };
  }
}

/** The N and Y on the approval card's buttons: their keys, while the card is on screen. */
function onKeys(c: Claude): Disposer {
  const onKey = (e: KeyboardEvent) => {
    const approval = c.store.pendingApproval;
    if (c.api.island.mode() !== "expanded" || c.api.island.view() !== "approval" || !approval) return;
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || (e.target as Element | null)?.closest("input, textarea")) return;
    const key = e.key.toLowerCase();
    const plan = approval.plan != null;
    if (key === "n") c.decide(plan ? "plan-keep" : "deny");
    else if (key === "y") c.decide(plan ? "plan-auto" : "allow");
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
