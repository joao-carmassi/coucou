// Agentes: Codex, Cursor, Gemini CLI, Copilot CLI and OpenCode on the island. Their hooks reach Rust
// on the channel "agents" and arrive here as "agents-hook". Each agent has a pill "agent_<id>"; an
// approval card exists only where a blocking hook does, and only while "agentsApprove" is on.
// Nothing is ever approved without a click (or a Y/N key on the card): the words are allow and deny.
import "./agents.css";
import type { Disposer, IslandApi, ModuleDef } from "../../core/moduleApi";
import { tile } from "../../kit/tile";
import type { BoardCardOf, BoardFocus, BoardPillOf } from "../board/api";
import { AGENTS_SERVICE, type AgentsList } from "./api";
import { AgentsBridge, type AgentRow } from "./bridge";
import { FINISHED_MS, FRESH, PENDING_MS, apply, keyWord, targetOf, wantsCard, type AgentState, type HookPayload } from "./logic";
import { buildApproval, type Held } from "./view";

const VIEW = "agents-approval";
const MOODS: Record<string, string> = {
  idle: "pronto", thinking: "pensando", working: "trabalhando", waiting: "aguardando", ask: "perguntando", done: "terminou", error: "erro",
};
const pillOf = (id: string) => `agent_${id}`;

interface Cfg { agentsApprove: unknown; agentsNotify: unknown }

class Agents {
  rows: AgentRow[] = [];
  held: Held | null = null;
  alive = true;
  readonly states = new Map<string, AgentState>();
  private gone = new Map<string, Disposer>();
  private offRequest: Disposer | null = null;
  private offTimer: Disposer | null = null;
  /** When the card last came on screen: the Y/N guard counts from here. */
  visibleAt = 0;

  constructor(readonly api: IslandApi) {}

  async refresh() {
    const rows = await AgentsBridge.list();
    if (this.alive) this.rows = rows;
  }

  ownsPill(taskId: string): string | null {
    const id = taskId.startsWith("agent_") ? taskId.slice(6) : "";
    return id && this.states.has(id) && this.rows.some((r) => r.id === id) ? id : null;
  }

  async onHook(p: HookPayload) {
    const id = p.coucou_agent ?? "";
    let row = this.rows.find((r) => r.id === id);
    // The relay's ack window is short: no waiting for the list to load.
    if (!row && p.hook_event_name === "PermissionRequest") {
      if (p.request_id) void AgentsBridge.decline(p.request_id);
      void this.refresh();
      return;
    }
    if (!row && this.alive) {
      await this.refresh();
      row = this.rows.find((r) => r.id === id);
    }
    if (!this.alive || !row) {
      if (p.request_id) void AgentsBridge.decline(p.request_id);
      return;
    }
    if (p.hook_event_name === "PermissionRequest") return this.offer(row, p);
    if (this.api.paused() && p.hook_event_name !== "SessionEnd") return;
    const prev = this.states.get(id) ?? FRESH;
    const next = apply(prev, p);
    if (next === prev) return;
    if (next.ended) return this.remove(id);
    this.states.set(id, next);
    this.gone.get(id)?.();
    this.gone.delete(id);
    this.api.pills.set({ id: pillOf(id), label: row.label, color: row.color, mood: next.mood });
    if (next.done || next.error) {
      this.gone.set(id, this.api.timeout(() => this.remove(id), FINISHED_MS));
      if (this.api.settings<Cfg>().agentsNotify === true) {
        this.api.island.notice({ text: `${row.label} ${next.error ? "parou com erro" : "terminou"}`, key: `agent-${id}`, peek: true });
      }
    }
    this.api.island.redraw();
  }

  private remove(id: string) {
    this.gone.get(id)?.();
    this.gone.delete(id);
    this.states.delete(id);
    this.api.pills.remove(pillOf(id));
    this.api.island.redraw();
  }

  private offer(row: AgentRow, p: HookPayload) {
    const requestId = p.request_id ?? "";
    if (!requestId) return;
    const approve = this.api.settings<Cfg>().agentsApprove === true;
    if (!wantsCard({ blocking: row.blocking, approve, paused: this.api.paused(), held: !!this.held })) {
      void AgentsBridge.decline(requestId);
      return;
    }
    this.held = { requestId, agent: row, target: targetOf(p.tool_name, p.tool_input), shownAt: performance.now() };
    // Under Claude's card (100), above its questions (90).
    this.offRequest = this.api.island.request({ view: VIEW, priority: 95, pin: true });
    this.offTimer = this.api.timeout(() => this.drop(requestId), PENDING_MS);
    // The relay's short ack window is 800 ms; the card is up by now.
    void AgentsBridge.ack(requestId);
    this.api.sound.play("alert");
    this.api.island.redraw();
  }

  /** The request is over, however it ended. */
  private drop(requestId: string) {
    if (this.held?.requestId !== requestId) return;
    this.offRequest?.();
    this.offTimer?.();
    this.offRequest = this.offTimer = null;
    this.held = null;
    this.api.island.redraw();
  }

  decide(word: "allow" | "deny") {
    const held = this.held;
    if (!held) return;
    this.drop(held.requestId);
    this.api.sound.play(word === "deny" ? "blip" : "approve");
    void AgentsBridge.decide(held.requestId, word);
  }

  /** Pause or stop: nobody can answer, so the agent goes back to its own prompt. */
  declineHeld() {
    const held = this.held;
    if (!held) return;
    this.drop(held.requestId);
    void AgentsBridge.decline(held.requestId);
  }

  onKey(e: KeyboardEvent) {
    const api = this.api;
    if (!this.held || api.island.mode() !== "expanded" || api.island.view() !== VIEW) return;
    if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
    const word = keyWord(e, performance.now() - this.visibleAt);
    if (word) this.decide(word);
  }
}

const instances = new WeakMap<IslandApi, Agents>();
function agentsOf(api: IslandApi): Agents {
  let a = instances.get(api);
  if (!a) instances.set(api, (a = new Agents(api)));
  return a;
}

export const agents: ModuleDef = {
  id: "agents",
  views: [{
    name: VIEW,
    layout: { height: 160, botX: 62, botY: null, botDiameter: 56 },
    build: (ctx) => {
      const a = agentsOf(ctx.api);
      return buildApproval({ get held() { return a.held; }, decide: (w) => a.decide(w) }, ctx);
    },
  }],
  start(api) {
    const a = agentsOf(api);
    void a.refresh();
    let showing = false;
    const keys = (e: KeyboardEvent) => a.onKey(e);
    window.addEventListener("keydown", keys);
    const offs = [
      api.listen<HookPayload>("agents-hook", (p) => void a.onHook(p)),
      api.onPause((paused) => { if (paused) a.declineHeld(); }),
      api.island.onChange(() => {
        const on = !!a.held && api.island.mode() === "expanded" && api.island.view() === VIEW;
        if (on && !showing) a.visibleAt = performance.now();
        showing = on;
      }),
      api.provide<AgentsList>(AGENTS_SERVICE.list, () => a.rows.map(({ configPath: _p, ...info }) => ({ ...info, live: a.states.has(info.id) ? 1 : 0 }))),
      api.provide<BoardCardOf>("board.card", (taskId) => {
        const id = a.ownsPill(taskId);
        const row = a.rows.find((r) => r.id === id);
        const st = id ? a.states.get(id) : undefined;
        if (!row || !st) return null;
        return { key: `${id}:${st.mood}:${st.step}`, build: () => tile({ title: row.label, sub: MOODS[st.mood] ?? "", dot: row.color, status: st.step }) };
      }),
      api.provide<BoardPillOf>("board.pill", (taskId) => (a.ownsPill(taskId) ? {} : null)),
      api.provide<BoardFocus>("board.focus", (taskId) => { if (a.ownsPill(taskId)) api.pills.focus(taskId); }),
    ];
    return () => {
      a.alive = false;
      window.removeEventListener("keydown", keys);
      a.declineHeld();
      offs.reverse().forEach((off) => off());
    };
  },
};
