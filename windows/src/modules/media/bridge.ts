import { commandOrThrow } from "../../kit/tauri";


/** A file copied into the inbox. */
export interface InboxFile { name: string; path: string; size: number }

export const MediaBridge = {
  /** Screenshots the window under the cursor into the inbox (Mochi dragged onto it). */
  attachWindow: () => commandOrThrow<InboxFile>("media_attach_window"),
  list: () => commandOrThrow<MediaItem[]>("media_list"),
  /** The file's preview as PNG bytes. */
  thumb: (path: string, px: number) => commandOrThrow<ArrayBuffer>("media_thumb", { path, px }),
  open: (path: string) => commandOrThrow<void>("media_open", { path }),
  openWith: (path: string) => commandOrThrow<void>("media_open_with", { path }),
  reveal: (path: string) => commandOrThrow<void>("media_reveal", { path }),
  /** Off the list only; the file stays on disk. */
  remove: (path: string) => commandOrThrow<void>("media_remove", { path }),
  toolInfo: (path: string) => commandOrThrow<ToolInfo>("media_tool_info", { path }),
  /** Starts a tool on a Rust worker; the id tags the `media-tool` events. */
  toolRun: (op: string, path: string, arg?: string) => commandOrThrow<number>("media_tool_run", { op, path, arg: arg ?? null }),
  toolCancel: (id: number) => commandOrThrow<void>("media_tool_cancel", { id }),
  ffmpegStatus: () => commandOrThrow<FfmpegStatus>("media_ffmpeg_status"),
  /** Only from the user's click. */
  ffmpegDownload: () => commandOrThrow<number>("media_ffmpeg_download"),
};

export interface ToolInfo {
  kind: "image" | "video" | "pdf" | "other";
  size: number; sizeText: string;
  width: number | null; height: number | null; pages: number | null;
  ops: string[]; ffmpeg: boolean;
}
export interface FfmpegStatus { path: string | null; url: string; bytes: number; sizeText: string; sha256: string }
/** Payload of the `media-tool` event. */
export interface ToolEvent {
  id: number; op: string;
  state: "progress" | "done" | "error" | "cancelled";
  pct: number; out: string | null; text: string | null; msg: string | null;
}

export interface MediaItem {
  path: string;
  name: string;
  /** "screenshot", "video" or "file". */
  kind: string;
  /** Unix ms. */
  ts: number;
  size: number;
}
