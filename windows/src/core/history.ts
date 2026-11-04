// The island's back/forward history (mouse side buttons): the screens the user went through, newest last. Pure: no DOM.

export interface NavEntry { view: string; state?: unknown }

export class NavHistory {
  private items: NavEntry[] = [];
  private at = -1;

  // shortcut: fixed cap of 30 (drops the oldest), make it a setting if anyone walks further back
  private max: number;
  constructor(max = 30) {
    this.max = max;
  }

  clear(): void {
    this.items = [];
    this.at = -1;
  }

  /** A user navigation. Same view and state as the current one: nothing. Anything ahead is cut. */
  push(e: NavEntry): void {
    const cur = this.items[this.at];
    if (cur && cur.view === e.view && cur.state === e.state) return;
    this.items.length = this.at + 1;
    this.items.push(e);
    if (this.items.length > this.max) this.items.shift();
    this.at = this.items.length - 1;
  }

  /**
   * The entry to go to, or null at an end. Entries `ok` refuses (a view gone, a module off) are dropped and skipped.
   * When the screen moved without being recorded (`here` is not the current entry's view), back is the current entry itself.
   */
  step(dir: -1 | 1, here: string, ok: (e: NavEntry) => boolean): NavEntry | null {
    const cur = this.items[this.at];
    if (dir < 0 && cur && cur.view !== here && ok(cur)) return cur;
    for (let i = this.at + dir; i >= 0 && i < this.items.length; i += dir) {
      if (ok(this.items[i])) {
        this.at = i;
        return this.items[i];
      }
      this.items.splice(i, 1);
      if (dir < 0) this.at--;
      else i--;
    }
    return null;
  }
}
