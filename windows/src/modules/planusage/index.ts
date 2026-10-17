// Uso do plano. Codex 5 h / weekly limits come from local files (Rust watches them; no network). Claude's come from an
// opt-in, unofficial network call (planusageClaudeNet, default off), made only while the view is open or on "Atualizar".
// One-line source "plan" (pinnable). Provides agents.usage (cached numbers, never fetches). Nothing runs by itself: no timer here, the view arms its own.
import "./planusage.css";
import { BAND, PANEL_H, type Disposer, type IslandApi, type ModuleDef } from "../../core/moduleApi";
import { svg } from "../../kit/dom";
import { ICONS } from "../../kit/icons";
import { AGENTS_SERVICE, type AgentUsage, type AgentsUsage } from "../agents/api";
import { planusageBridge } from "./bridge";
import { claudeFresh, dueNotices, lineText } from "./logic";
import { buildPlanusageView, type Ctrl } from "./view";

const msg = (e: unknown) => String(e).replace(/^Error:\s*/, "");

let ctrl: Ctrl = { codex: () => null, claude: () => null, netOn: () => false, refresh: async () => {} };
let listeners: (() => void)[] = [];
const subscribe = (fn: () => void) => { listeners.push(fn); };

function start(api: IslandApi): Disposer {
  let codex: AgentUsage | null = null;
  let claude: AgentUsage | null = null;
  let claudeAt: number | null = null;
  let pending: Promise<void> | null = null;
  let alive = true;
  const seen = new Map<string, number>();
  const source = api.status.source("plan", { label: "Uso do plano", view: "planusage" });
  const netOn = () => api.settings<{ planusageClaudeNet: boolean }>().planusageClaudeNet === true;

  const showLine = () => {
    const text = lineText(codex, netOn() ? claude : null, Date.now());
    source.set(text ? { priority: BAND.AMBIENT, text } : api.status.pinned("plan") ? { priority: BAND.AMBIENT, text: codex?.error ?? "Uso do plano: sem dados", dim: true } : null);
  };
  const changed = () => { showLine(); listeners.slice().forEach((f) => f()); };
  const warn = (u: AgentUsage) => {
    if (u.error) return;
    for (const n of dueNotices(u, seen, Date.now())) api.island.notice({ text: n.text, key: n.key, view: "planusage", priority: BAND.NOTICE, peek: true, ms: 5000 });
  };
  const applyCodex = (list: readonly AgentUsage[] | null) => {
    codex = list?.find((u) => u.agent === "codex") ?? codex;
    if (codex) warn(codex);
    changed();
  };
  const fetchClaude = (force: boolean): Promise<void> => {
    if (!netOn()) return Promise.resolve();
    if (pending) return pending;
    if (!force && claudeFresh(claudeAt, Date.now())) return Promise.resolve();
    pending = planusageBridge.claude().then(
      (u) => { claude = u; },
      (e) => { claude = { agent: "claude", windows: [], source: "network", at: Date.now(), error: msg(e) }; },
    ).then(() => {
      claudeAt = Date.now();
      pending = null;
      if (!alive) return;
      if (claude) warn(claude);
      changed();
    });
    return pending;
  };
  ctrl = {
    codex: () => codex,
    claude: () => claude,
    netOn,
    refresh: async (force) => {
      if (force) await planusageBridge.get().then(applyCodex, () => {});
      await fetchClaude(force);
    },
  };

  const usage: AgentsUsage = async (agent) => {
    // Cached only: the network is reached from the open view or "Atualizar", never from a consumer.
    return [codex, netOn() ? claude : null].filter((u): u is AgentUsage => !!u && (!agent || u.agent === agent));
  };
  const offs = [
    api.provide(AGENTS_SERVICE.usage, usage),
    api.listen<AgentUsage[]>("planusage-changed", applyCodex),
    api.island.onChange(showLine),
    // Opt-in turned off: forget Claude's numbers at once (deferred: stored settings are replaced after listeners run).
    api.listen("settings-changed", () => void api.timeout(() => { if (!netOn()) { claude = null; claudeAt = null; } changed(); }, 0)),
  ];
  void planusageBridge.get().then(applyCodex, () => {});
  showLine();
  return () => {
    alive = false;
    offs.forEach((o) => o());
    source.dispose();
    ctrl = { codex: () => null, claude: () => null, netOn: () => false, refresh: async () => {} };
    listeners = [];
  };
}

export const planusageModule: ModuleDef = {
  id: "planusage",
  views: [{
    name: "planusage",
    layout: { height: PANEL_H, botX: 54, botY: null, botDiameter: 46 },
    build: (ctx) => buildPlanusageView(ctx, { codex: () => ctrl.codex(), claude: () => ctrl.claude(), netOn: () => ctrl.netOn(), refresh: (f) => ctrl.refresh(f) }, subscribe),
  }],
  tabs: [{ view: "planusage", title: "Uso do plano", icon: () => svg(ICONS.dial, 13, { stroke: 1.6 }), order: 52 }],
  start,
};
