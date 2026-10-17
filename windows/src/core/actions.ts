// The core's list of module actions (api.actions.add) behind Alt+<key> and api.actions.all. Pure: no DOM, no timers.
// `onWarn` is injectable so tests can see duplicate keys without console noise.

import type { ActionDef } from "./moduleApi";

export interface Action {
  /** "<owner>.<id>" */
  key: string;
  owner: string;
  def: ActionDef;
}
export class ActionList {
  private list: Action[] = [];
  onWarn: (msg: string) => void = (m) => console.warn(`[coucou] ${m}`);

  /** Stamps the id; the same stamped id replaces. A hotkey already taken warns and the first holder keeps it. */
  add(owner: string, def: ActionDef): () => void {
    const key = `${owner}.${def.id}`;
    this.list = this.list.filter((a) => a.key !== key);
    const k = def.key;
    if (k != null && (!/^[a-z0-9]$/.test(k) || this.list.some((a) => a.def.key === k))) {
      this.onWarn(`action ${key}: key "${k}" is invalid or taken, Alt+${k} stays with the first`);
      def = { ...def, key: undefined };
    }
    const a: Action = { key, owner, def };
    this.list.push(a);
    return () => void (this.list = this.list.filter((x) => x !== a));
  }

  dropOwner(owner: string): void {
    this.list = this.list.filter((a) => a.owner !== owner);
  }

  /** The ones whose `when` allows them now (a throwing `when` hides the action). */
  all(): Action[] {
    return this.list.filter((a) => {
      try { return a.def.when?.() !== false; } catch { return false; }
    });
  }

  byKey(k: string): Action | null {
    return this.all().find((a) => a.def.key === k) ?? null;
  }

  /** Runs by stamped key; a throw or a rejection goes to `onError`. False when unknown or not allowed now. */
  run(key: string, onError: (err: unknown) => void): boolean {
    const a = this.all().find((x) => x.key === key);
    return a ? this.exec(a.def.run, onError) : false;
  }

  /** Runs a function, routing a throw or rejection to `onError`. */
  exec(fn: () => void | Promise<void>, onError: (err: unknown) => void): boolean {
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(onError);
    } catch (err) {
      onError(err);
    }
    return true;
  }

  clear(): void {
    this.list = [];
  }
}

export const Actions = new ActionList();
