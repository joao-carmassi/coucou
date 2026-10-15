// The core's list of module actions (api.actions.add) behind the palette and Alt+<key>. Pure: no DOM, no timers.
// `onWarn` is injectable so tests can see duplicate keys without console noise.

import type { ActionDef } from "./moduleApi";

export interface Action {
  /** "<owner>.<id>" */
  key: string;
  owner: string;
  def: ActionDef;
}
/** What the palette lists: an action or a core entry ("go to tab"). */
export interface Entry { key: string; title: string; keywords?: readonly string[]; run(): void | Promise<void> }

/** Lowercase, accents removed. */
export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** 0 prefix, 1 word start, 2 substring, null no match (q already folded). */
function rank(text: string, q: string): number | null {
  const t = fold(text);
  if (t.startsWith(q)) return 0;
  if (t.split(/[\s\-_.:/]+/).some((w) => w.startsWith(q))) return 1;
  return t.includes(q) ? 2 : null;
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

  /** Actions then `extra`, best match first (prefix > word start > substring; keywords rank after the title); empty query = all. */
  search(q: string, extra: readonly Entry[] = []): Entry[] {
    const f = fold(q.trim());
    const entries: Entry[] = [...this.all().map((a) => ({ key: a.key, title: a.def.title, keywords: a.def.keywords, run: a.def.run })), ...extra];
    if (!f) return entries;
    const scored: { e: Entry; s: number; i: number }[] = [];
    entries.forEach((e, i) => {
      let s = rank(e.title, f);
      if (s == null) {
        for (const k of e.keywords ?? []) {
          const r = rank(k, f);
          if (r != null && (s == null || r + 3 < s)) s = r + 3;
        }
      }
      if (s != null) scored.push({ e, s, i });
    });
    return scored.sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.e);
  }

  /** Runs by stamped key; a throw or a rejection goes to `onError`. False when unknown or not allowed now. */
  run(key: string, onError: (err: unknown) => void): boolean {
    const a = this.all().find((x) => x.key === key);
    return a ? this.exec(a.def.run, onError) : false;
  }

  /** Runs any palette entry the same way. */
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
