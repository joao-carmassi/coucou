import { commandOrThrow } from "../../core/bridge";


/** A file copied into the inbox. */
export interface InboxFile { name: string; path: string; size: number }

export const MediaBridge = {
  /** Screenshots the window under the cursor into the inbox (Mochi dragged onto it). */
  attachWindow: () => commandOrThrow<InboxFile>("attach_window"),
  list: () => commandOrThrow<MediaItem[]>("media_list"),
  /** The file's preview as PNG bytes. */
  thumb: (path: string, px: number) => commandOrThrow<ArrayBuffer>("media_thumb", { path, px }),
  open: (path: string) => commandOrThrow<void>("media_open", { path }),
  openWith: (path: string) => commandOrThrow<void>("media_open_with", { path }),
  reveal: (path: string) => commandOrThrow<void>("media_reveal", { path }),
  /** Off the list only; the file stays on disk. */
  remove: (path: string) => commandOrThrow<void>("media_remove", { path }),
};

export interface MediaItem {
  path: string;
  name: string;
  /** "screenshot", "video" or "file". */
  kind: string;
  /** Unix ms. */
  ts: number;
  size: number;
}
