// The Claude module's own state: sessions, the one in front, what each changed. Moved out of
// core/state.ts (m3-ok). Nothing here is global: one store per module start.

import type { ManagedSession } from "./bridge";
import type { IslandApi } from "../../core/moduleApi";
import { State } from "../../core/state";
import {
  CLAUDE_ID, newSession,
  type ApprovalInfo, type ChangedFile, type ClaudeClient, type ClaudeSession, type PillBadge, type QuestionInfo,
} from "./types";

/** This module's settings keys (manifest settingsDefaults); Rust keeps them in `extra`. */
export interface ClaudeSettings {
  hooksInstalled: boolean;
  /** A second Claude account: Claude Code's config folder on Windows; empty = the default. */
  claudeConfigDir: string;
  /** What the idle Claude card opens: "" = Visual Studio Code, "terminal" = Claude Code in a terminal. */
  idleOpen: string;
  /** Global hotkey that takes the island to the pending alert; "" = none. */
  alertHotkey: string;
}

export const claudeSettings = (api: IslandApi): Readonly<ClaudeSettings> => api.settings<ClaudeSettings>();

/** What the Claude pill is called while it follows a session from that app. */
export const CLIENT_NAMES: Record<ClaudeClient, string> = {
  desktop: "Claude",
  vscode: "VS Code",
  terminal: "Terminal",
};
/** Until a session has spoken, the pill keeps the name it always had. */
export const CLIENT_UNKNOWN = "VS Code";

export class ClaudeStore {
  constructor(private readonly api: IslandApi) {}

  /** Every session the island knows of, in the order they were first heard. */
  sessions: ClaudeSession[] = [];
  /** The session in front; empty when there is none. */
  frontId = "";
  /** What stands for the session in front while there is none. */
  private readonly noSession = newSession("");
  /** What each session changed, by session id. */
  changes = new Map<string, ChangedFile[]>();
  /** Every session of every Claude profile, running or not. */
  managedSessions: ManagedSession[] = [];
  /** Badges on the pills of the overview, by task id. */
  badges = new Map<string, PillBadge>();
  /** The last lines of the third-party agents' pills (Pill has no steps of its own). */
  agentSteps = new Map<string, string[]>();

  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Something changed: whoever mirrors the store into the core runs. */
  changed() {
    for (const fn of [...this.listeners]) fn();
  }

  /** The session in front: the one the Claude pill, the cards and the panel show. */
  get session(): ClaudeSession {
    return this.sessions.find((s) => s.id === this.frontId) ?? this.noSession;
  }

  get pendingApproval(): ApprovalInfo | null {
    return this.session.approval;
  }

  get pendingQuestion(): QuestionInfo | null {
    return this.session.question;
  }

  /** Any session with a request waiting for an answer. */
  hasPending(): boolean {
    return this.sessions.some((s) => s.approval != null || s.question != null);
  }

  /** The other sessions waiting on a human, the one that has waited longest first. */
  get waiting(): ClaudeSession[] {
    return this.sessions.filter((s) => s.id !== this.frontId && (s.approval != null || s.question != null));
  }

  /** The Claude pill's name: the app of the session it follows. */
  get clientName(): string {
    if (this.session.client) return CLIENT_NAMES[this.session.client];
    return claudeSettings(this.api).idleOpen === "terminal" ? CLIENT_NAMES.terminal : CLIENT_UNKNOWN;
  }

  /** The files the session being followed has changed, the last touched first. */
  get sessionFiles(): ChangedFile[] {
    return this.changes.get(this.session.id) ?? [];
  }

  /** The Claude pill, when the module has put it among the tasks. */
  get pill() {
    return State.pills.find((t) => t.id === CLAUDE_ID) ?? null;
  }

  /**
   * Puts a session in front. The one it takes the place of keeps going where
   * it runs; if it was waiting for an answer, its tab says so.
   */
  bringForward(id: string) {
    const from = this.session;
    if (from.id && from.id !== id && (from.approval || from.question)) from.news = "alert";
    this.frontId = id;
    this.session.news = null;
    this.present();
  }

  /** The Claude pill wears the session in front: its project, its state. */
  present() {
    if (this.pill) {
      const s = this.session;
      this.api.pills.set({ id: CLAUDE_ID, label: s.id ? s.project : this.clientName, mood: s.state });
    }
    this.changed();
  }

  setBadge(id: string, badge: PillBadge | null) {
    if (badge) this.badges.set(id, badge);
    else this.badges.delete(id);
    this.changed();
  }
}
