// What the board offers every module (services, via api.provide / api.use). Types only: providers
// and consumers `import type` from here and spell the key literally.
//
// The board owns the home tab and the `overview` view: the focused pill's card on the left, the other
// pills on the right. It draws nothing of its own for a pill: it asks the modules, which answer only for
// the pills they own. A key with no provider is a pill without that feature.

import type { PillBadge } from "../../core/state";

/** A pill's card in the board's left slot, dressed in the tile-* classes (board.css); `key` changes when it must be redrawn. */
export interface BoardCard {
  key: string;
  /** `actions.blip()` is the island's click sound. */
  build(actions: { blip(): void }): HTMLElement;
  /** Called on every redraw while the card is shown (a card that keeps its own DOM updates it here). */
  sync?(): void;
  /** The whole card is a button: a click that is not on a button inside it (the board plays the blip). */
  open?(): void;
  /** Tooltip of an `open` card. */
  hint?: string;
  /** Pixels the island grows by for this card. */
  room?: number;
  /** A click on the card (with no `open`) calls pillOpen for this pill. */
  target?: boolean;
}
/** News a module's pill tells: finished/error cards show it in place of a result. */
export interface BoardNews { says: string; title: string; facts: Node[] }
/** How a pill looks in the right-hand list, when it differs from the pill itself. */
export interface BoardPill { label?: string; badge?: PillBadge }

/** "board.card": offered by the module that owns the pill. */
export type BoardCardOf = (taskId: string) => BoardCard | null;
/** "board.news" */
export type BoardNewsOf = (taskId: string) => BoardNews | null;
/** "board.pill" */
export type BoardPillOf = (taskId: string) => BoardPill | null;
/** "board.focus": the user clicked a pill in the list; the owner puts it in front (api.pills.focus). Ignore others' pills. */
export type BoardFocus = (taskId: string) => void;
/** "board.host": present while the board is running. */
export type BoardHost = true;
