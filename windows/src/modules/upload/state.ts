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
};
