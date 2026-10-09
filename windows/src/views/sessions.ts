// Sessions view: every Claude Code session of every profile, running or not.
// Running ones can be focused, offline ones resumed (in a terminal), any can be
// erased (two clicks). The 5 s poll of the running ones lives only while the
// view is on screen — hidden, the island costs nothing.

import { h } from "./dom";
import { timeAgo } from "./integrations";
import { Bridge, type ClaudeProfile, type LiveSession, type ManagedSession } from "../core/bridge";
import { State } from "../core/state";
import type { ViewHost } from "./views";


const folderName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const message = (err: unknown) => String(err).replace(/^Error:\s*/, "");
const keyOf = (s: { profile: string; id: string }) => `${s.profile}\u0000${s.id}`;

export function buildSessionsView(onResize: () => void): ViewHost {
  let profiles: ClaudeProfile[] = [];
  let all: ManagedSession[] = [];
  let live = new Map<string, LiveSession>();
  let filter: string | null = null;
  let armed: string | null = null;
  let error = "";
  let timer: number | undefined;
  let seen = "";
  let drawn = "";
  let height: number | undefined;

  const chips = h("div", { class: "sess-chips" });
  const newBtn = h("button", { class: "btn secondary sess-newbtn", text: "Nova sessão", onclick: () => void newSession() });
  const list = h("div", { class: "sess-list" });
  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body sess-view" }, h("div", { class: "sess-head" }, chips, newBtn), list)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");
  // A click anywhere else disarms "Excluir?".
  el.addEventListener("click", (e) => {
    if (armed != null && !(e.target as Element).closest(".sess-del")) {
      armed = null;
      draw();
    }
  });

  const label = (key: string) => profiles.find((p) => p.key === key)?.label ?? key;
  const isOn = () => State.mode === "expanded" && State.view === "prompt";

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      error = "";
    } catch (err) {
      error = message(err);
    }
    await load();
  }

  async function newSession() {
    const profile = filter ?? (profiles.find((p) => p.isDefault) ?? profiles[0])?.key ?? "";
    await run(() => Bridge.sessionLaunch({ profile, cwd: null, resume: null, attach: null }));
  }

  async function load() {
    try {
      if (profiles.length === 0) profiles = (await Bridge.claudeProfiles()) ?? [];
      all = (await Bridge.sessionsAll()) ?? [];
      State.managedSessions = all;
      live = new Map((await Bridge.sessionsLive() ?? []).map((l) => [keyOf(l), l]));
    } catch (err) {
      error = message(err);
    }
    draw();
  }

  async function poll() {
    if (!isOn()) return stop();
    try {
      live = new Map(((await Bridge.sessionsLive()) ?? []).map((l) => [keyOf(l), l]));
      draw();
    } catch { /* next tick */ }
  }

  function stop() {
    armed = null;
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  }

  function row(s: ManagedSession): HTMLElement {
    const l = live.get(keyOf(s));
    const running = l != null || s.status === "running";
    const hook = State.sessions.find((x) => x.id === s.id);
    const waiting = running && hook != null && (hook.approval != null || hook.question != null);
    const isArmed = armed === keyOf(s);
    const act = running
      ? h("button", { class: "btn secondary sess-act", text: "Focar", onclick: () => void run(async () => {
          // The bridge reports failure as a falsy result, never by throwing.
          if (!(await Bridge.openTerminal(s.cwd, hook?.wslDistro ?? null, [l?.pid ?? s.pid, ...(hook?.terminalPids ?? [])].filter((p): p is number => !!p))))
            throw new Error("Não foi possível abrir o terminal.");
        }) })
      : h("button", { class: "btn secondary sess-act", text: "Retomar", onclick: () => void run(() => Bridge.sessionLaunch({ profile: s.profile, cwd: s.cwd, resume: s.id, attach: null })) });
    // A running session can't be erased (Rust refuses): no × for it.
    const del = running ? null : h("button", {
      class: isArmed ? "sess-del armed" : "sess-del",
      title: isArmed ? "Clique de novo para apagar o histórico desta sessão" : "Excluir esta sessão",
      text: isArmed ? "Excluir?" : "×",
      onclick: () => {
        if (!isArmed) {
          armed = keyOf(s);
          return draw();
        }
        armed = null;
        void run(() => Bridge.sessionErase(s.profile, s.id));
      },
    });
    return h(
      "div",
      { class: "sess-row" },
      h("i", { class: `sess-dot ${waiting ? "wait" : running ? "run" : ""}`, title: waiting ? "Esperando você" : running ? "Rodando" : "Parada" }),
      h("div", { class: "sess-pick" },
        h("span", { class: "sess-title", text: s.title || "Sem título" }),
        h("span", { class: "sess-folder", text: `${folderName(s.cwd)} · ${timeAgo(s.updated)}`, title: s.cwd })),
      profiles.length > 1 ? h("span", { class: "sess-badge", text: label(s.profile) }) : null,
      act,
      del,
    );
  }

  function draw() {
    const rows = all.filter((s) => filter == null || s.profile === filter);
    // Running first, then newest.
    rows.sort((a, b) => Number(live.has(keyOf(b)) || b.status === "running") - Number(live.has(keyOf(a)) || a.status === "running") || b.updated - a.updated);
    const sig = JSON.stringify([filter, armed, error, profiles.length, rows.map((s) => [keyOf(s), s.title, s.updated, live.has(keyOf(s)), s.status]),
      State.sessions.map((x) => [x.id, x.approval != null, x.question != null])]);
    if (sig === drawn) return;
    drawn = sig;
    chips.replaceChildren(...(profiles.length > 1
      ? [null, ...profiles.map((p) => p.key)].map((k) =>
          h("button", { class: k === filter ? "sess-chip on" : "sess-chip", text: k == null ? "Todos" : label(k), onclick: () => { filter = k; draw(); } }))
      : []));
    list.replaceChildren(
      ...(error ? [h("div", { class: "sess-error", text: error })] : []),
      ...rows.map(row),
      ...(rows.length === 0 && !error ? [h("div", { class: "sess-empty", text: "Nenhuma sessão ainda" })] : []),
    );
    const next = Math.max(200, Math.min(300, 130 + rows.length * 34));
    if (next !== height) {
      height = next;
      onResize();
    }
  }

  return {
    el,
    sync() {
      if (!isOn()) return stop();
      // Hook activity (start, end, a turn done) changes this signature: reload.
      const sig = State.sessions.map((s) => `${s.id}:${s.state}`).join();
      if (sig !== seen) {
        seen = sig;
        void load();
      }
      if (timer === undefined) {
        void load();
        timer = window.setInterval(() => void poll(), 5000);
      }
      draw();
    },
    get height() {
      return height;
    },
  };
}
