// Starts and stops modules. The ONLY core file that imports ../modules.
// Nothing here runs at import time: no timers, no listeners.

import { Avatar } from "./avatar";
import { Bridge, command, onEvent } from "./bridge";
import { Compact } from "./compact";
import { Hooks, Services, onMode } from "./hooks";
import { resolveEnabled } from "./moduleApi";
import type { AvatarSignal, Disposer, IslandApi, IslandHooks, IslandHost, ModuleDef, StatusLine } from "./moduleApi";
import { State } from "./state";
import { MODULE_INFO } from "../modules/catalog";
import { MODULES } from "../modules/index";

/** Disposers, run in reverse; one failing never blocks the rest. */
export class Scope {
  private items = new Set<Disposer>();
  add(d: Disposer): Disposer {
    this.items.add(d);
    return d;
  }
  remove(d: Disposer) {
    this.items.delete(d);
  }
  dispose() {
    for (const d of [...this.items].reverse()) {
      try { d(); } catch (err) { console.error("[coucou] dispose failed", err); }
    }
    this.items.clear();
  }
}

function makeApi(id: string, scope: Scope, host: IslandHost): IslandApi {
  const timeout = (fn: () => void, ms: number): Disposer => {
    const d: Disposer = () => window.clearTimeout(t);
    const t = window.setTimeout(() => { scope.remove(d); fn(); }, ms);
    return scope.add(d);
  };
  /** The resolvers check ttl at draw time: redraw once it has passed. One timer per kind. */
  const expiry: Record<"status" | "avatar", Disposer | null> = { status: null, avatar: null };
  const expire = (kind: "status" | "avatar", ttlMs?: number) => {
    expiry[kind]?.();
    if (expiry[kind]) scope.remove(expiry[kind]!);
    expiry[kind] = ttlMs != null ? timeout(() => { expiry[kind] = null; host.redraw(); }, ttlMs + 20) : null;
  };

  const badged = new Set<string>();
  scope.add(() => { for (const t of badged) State.setPillBadge(t, null); });

  return {
    id,
    pill: { badge(taskId, badge) { badged.add(taskId); State.setPillBadge(taskId, badge); } },
    settings: () => State.settings,
    invoke: (cmd, args) => command(cmd, args),
    listen<T>(event: string, fn: (p: T) => void): Disposer {
      let off: (() => void) | null = null;
      let dead = false;
      void onEvent<T>(event, fn).then((u) => (dead ? u() : (off = u)));
      return scope.add(() => { dead = true; off?.(); });
    },
    timeout,
    interval(fn, ms, opts) {
      let t: number | null = null;
      const arm = () => { if (t == null) t = window.setInterval(fn, ms); };
      const disarm = () => { if (t != null) window.clearInterval(t); t = null; };
      if (!opts?.whenVisible || State.mode !== "hidden") arm();
      const off = opts?.whenVisible ? onMode((mode) => (mode === "hidden" ? disarm() : arm())) : null;
      return scope.add(() => { off?.(); disarm(); });
    },
    status: {
      set(line: StatusLine | null) {
        if (Compact.set(id, line)) host.redraw();
        expire("status", line?.ttlMs);
      },
    },
    avatar: {
      publish(sig: AvatarSignal | null) {
        if (Avatar.publish(id, sig)) host.redraw();
        expire("avatar", sig?.ttlMs);
      },
      emote: (e) => host.avatarEmote(e),
      morph: (v) => host.avatarMorph(v),
      gulp: () => host.avatarGulp(),
      tint: (c) => host.avatarTint(c),
      bodyColor: () => host.avatarBodyColor(),
    },
    island: {
      open: (view, opts) => host.open(view, opts?.pinMs),
      setView: (v) => host.setView(v),
      close: () => host.collapse(),
      wake: () => host.reveal(),
      hide: () => host.hide(),
      keepAwake: (pred) => scope.add(Hooks.provide("keepAwake", pred)),
      isVisible: () => State.mode !== "hidden",
      mode: () => State.mode,
      fsmState: () => host.fsmState(),
      mouseInside: () => host.mouseInside(),
      view: () => State.view,
      note: (t) => host.note(t),
      error: (e) => host.error(e),
      pendingAlert: () => host.pendingAlert(),
      layoutHint: () => host.layoutHint(),
      redraw: () => host.redraw(),
      overlay: (o) => scope.add(host.addOverlay(o)),
    },
    provide: ((key: string, impl: unknown) =>
      scope.add(key.includes(".") ? Services.provide(key, impl) : Hooks.provide(key as keyof IslandHooks, impl as never))) as IslandApi["provide"],
    use: <T>(key: string) => Services.all(key)[0] as T | undefined,
    useAll: <T>(key: string) => Services.all(key) as T[],
    call: (hook, ...args) => Hooks.first(hook, ...args),
    onVisibility: (fn) => scope.add(onMode(fn)),
  };
}

let host: IslandHost | null = null;
const running = new Map<string, { def: ModuleDef; scope: Scope }>();

function start(h: IslandHost, def: ModuleDef) {
  const scope = new Scope();
  const api = makeApi(def.id, scope, h);
  try {
    const ctx = { actions: h.actions, onResize: () => h.layoutHint(), api };
    for (const v of def.views ?? []) scope.add(h.addView(v, ctx));
    const stop = def.start(api);
    if (stop) scope.add(stop);
    running.set(def.id, { def, scope });
    void Bridge.log(`[module] start ${def.id}`);
  } catch (err) {
    scope.dispose();
    console.error(`[coucou] module ${def.id} failed to start`, err);
    void Bridge.log(`[module] start ${def.id} FAILED ${String(err)}`);
  }
}

function stop(id: string) {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  r.scope.dispose();
  Compact.set(id, null);
  Avatar.publish(id, null);
  void Bridge.log(`[module] stop ${id}`);
}

export const Registry = {
  init(h: IslandHost) {
    host = h;
  },
  defaults: (stored: Readonly<Record<string, boolean>>) => resolveEnabled(MODULE_INFO, stored),
  isOn: (id: string) => State.modules[id] === true,
  /** Ids with no ModuleDef are ignored. */
  apply(map: Readonly<Record<string, boolean>>) {
    if (!host) return;
    const want = resolveEnabled(MODULE_INFO, map);
    State.modules = want;
    const order = MODULE_INFO.map((m) => m.id);
    for (const id of [...running.keys()].sort((a, b) => order.indexOf(b) - order.indexOf(a))) {
      if (!want[id]) stop(id);
    }
    for (const id of order) {
      const def = MODULES.find((m) => m.id === id);
      if (def && want[id] && !running.has(id)) start(host, def);
    }
    host.setTabs([...running.values()].flatMap((r) => (r.def.tabs ?? [])).sort((a, b) => a.order - b.order));
    host.redraw();
  },
};
