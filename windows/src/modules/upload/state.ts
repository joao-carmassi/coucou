// Module-local drop state (it used to live in State).
export const Up = {
  /** A file is being dragged over the island. */
  dragOver: false,
  droppedFile: null as { name: string; path: string } | null,
  /** 0..1, driven by the sequence clock. */
  progress: 0,
  /** Seconds the bar takes to fill. */
  duration: 2.4,
  /** The inbox copy has landed: droppedFile.path is the copy. */
  ingested: false,
  /** The background inbox copy in flight, so the choose step waits for it instead of copying twice. */
  ingest: null as Promise<{ name: string; path: string }> | null,
};
/** The hold on the choose card: taken when it comes up, dropped by the choice (launch or cancel). */
export const chooseHold: { off: (() => void) | null } = { off: null };
export const concludeChoose = () => { chooseHold.off?.(); chooseHold.off = null; };
