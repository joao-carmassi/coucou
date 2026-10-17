import { commandOrThrow } from "../../kit/tauri";
import type { Track } from "./logic";

export type Control = "toggle" | "next" | "prev";

export const NowPlayingBridge = {
  /** The last state the media session reported, or null when nothing is on. */
  state: () => commandOrThrow<Track | null>("nowplaying_state"),
  control: (action: Control) => commandOrThrow<void>("nowplaying_control", { action }),
  /** Spectrum capture (loopback of the output device) on or off. */
  capture: (on: boolean) => commandOrThrow<void>("nowplaying_capture", { on }),
};
