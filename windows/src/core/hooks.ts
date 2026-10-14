// Extension points the island calls; modules fill them through the registry.
// The island imports THIS file, never the modules. No timers or listeners at import.

import type { IslandMode } from "./layout";
import type { Disposer, HomeRequest, IslandHooks } from "./moduleApi";

type Fn = (...args: never[]) => unknown;
const table = new Map<string, Set<Fn>>();
const modeFns = new Set<(mode: IslandMode, prev: IslandMode) => void>();

function run(hook: string, args: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const fn of table.get(hook) ?? []) {
    try {
      out.push((fn as (...a: unknown[]) => unknown)(...args));
    } catch (err) {
      console.error(`[coucou] hook ${hook} failed`, err);
    }
  }
  return out;
}

export const Hooks = {
  provide<K extends keyof IslandHooks>(hook: K, fn: IslandHooks[K]): Disposer {
    let set = table.get(hook);
    if (!set) table.set(hook, (set = new Set()));
    set.add(fn as Fn);
    return () => void set.delete(fn as Fn);
  },
  all<K extends keyof IslandHooks>(hook: K, ...args: Parameters<IslandHooks[K]>): ReturnType<IslandHooks[K]>[] {
    return run(hook, args) as ReturnType<IslandHooks[K]>[];
  },
  /** First truthy answer. */
  first<K extends keyof IslandHooks>(hook: K, ...args: Parameters<IslandHooks[K]>): ReturnType<IslandHooks[K]> | undefined {
    return (Hooks.all(hook, ...args) as unknown[]).find(Boolean) as ReturnType<IslandHooks[K]> | undefined;
  },
  has(hook: keyof IslandHooks): boolean {
    return (table.get(hook)?.size ?? 0) > 0;
  },
  some<K extends keyof IslandHooks>(hook: K, ...args: Parameters<IslandHooks[K]>): boolean {
    return (Hooks.all(hook, ...args) as unknown[]).some(Boolean);
  },
  /** The home request with the highest priority; `pinned = false` ignores pinned requests. */
  home(pinned = true): HomeRequest | null {
    let best: HomeRequest | null = null;
    for (const r of Hooks.all("homeView")) if (r && (pinned || !r.pin) && (!best || r.priority > best.priority)) best = r;
    return best;
  },
};

const services = new Map<string, Set<unknown>>();
/** Typed by the module that owns the key (its api.ts); the core only stores them. */
export const Services = {
  provide(key: string, impl: unknown): Disposer {
    let set = services.get(key);
    if (!set) services.set(key, (set = new Set()));
    set.add(impl);
    return () => void set.delete(impl);
  },
  all: (key: string): unknown[] => [...(services.get(key) ?? [])],
};

/** Home: the strongest module request, else the tab flagged `home`, else the first tab (tabs come sorted by order), else the empty card. */
export function homeOf(home: HomeRequest | null, tabs: { view: string; home?: true }[]): string {
  return home?.view ?? tabs.find((t) => t.home)?.view ?? tabs[0]?.view ?? "empty";
}

export function onMode(fn: (mode: IslandMode, prev: IslandMode) => void): Disposer {
  modeFns.add(fn);
  return () => void modeFns.delete(fn);
}

export function emitMode(mode: IslandMode, prev: IslandMode) {
  for (const fn of [...modeFns]) {
    try { fn(mode, prev); } catch (err) { console.error("[coucou] onMode failed", err); }
  }
}
