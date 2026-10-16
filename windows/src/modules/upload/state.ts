// Module-local drop state (it used to live in State).
export const Up = {
  /** A file is being dragged over the island. */
  dragOver: false,
  /** `source` is the file where the user dropped it from (results go next to it); `path` may be the inbox copy. */
  droppedFile: null as { name: string; path: string; source?: string } | null,
  /** 0..1, driven by the sequence clock. */
  progress: 0,
  /** Seconds the bar takes to fill. */
  duration: 2.4,
  /** The inbox copy has landed: droppedFile.path is the copy. */
  ingested: false,
  /** The background inbox copy in flight, so the choose step waits for it instead of copying twice. */
  ingest: null as Promise<{ name: string; path: string }> | null,
};
