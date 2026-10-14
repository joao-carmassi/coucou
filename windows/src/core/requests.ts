// The core's one list of module requests for the island (api.island.request). Pure: no DOM, no timers.
// Highest priority is in front, the newest wins a tie. The pin is whatever the front request says.

export interface RequestSpec {
  view: string;
  priority: number;
  /** Keeps the island open (no auto-close, no Esc / click-outside) while this request is in front. */
  pin?: boolean;
  /** Auto-disposes after this long. */
  ms?: number;
  /** Queues (and pins) without taking the screen now; the view shows when the island next opens on it. */
  quiet?: boolean;
}
export interface Req extends RequestSpec { id: number; owner: string }

export class RequestQueue {
  private list: Req[] = [];
  private seq = 0;
  /** The island was closed while requests waited: they stay (a hover brings the card back) but do not pin until it reopens on them. */
  parked = false;

  add(owner: string, spec: RequestSpec): Req {
    const r = { ...spec, owner, id: ++this.seq };
    this.list.push(r);
    return r;
  }

  remove(r: Req): boolean {
    const at = this.list.indexOf(r);
    if (at >= 0) this.list.splice(at, 1);
    return at >= 0;
  }

  /** Highest priority; on a tie the newest. */
  front(): Req | null {
    let best: Req | null = null;
    for (const r of this.list) if (!best || r.priority >= best.priority) best = r;
    return best;
  }

  /** The front request holds the island open. */
  pinned(): boolean {
    return !this.parked && this.front()?.pin === true;
  }

  /** Any pinned request is waiting (parked or not). */
  busy(): boolean {
    return this.list.some((r) => r.pin);
  }

  clear() {
    this.list = [];
    this.parked = false;
  }
}

export const Requests = new RequestQueue();
