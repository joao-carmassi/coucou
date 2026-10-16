// State of the module (not in State): the last track, the last spectrum, and the view's repaint hooks.
import type { Track } from "./logic";

export const NP = {
  track: null as Track | null,
  /** Latest band levels 0..1, empty when no spectrum is running. */
  bands: [] as number[],
  sens: 1,
  /** Set by the view while it is built: repaint the progress / the bars. */
  paintProgress: null as (() => void) | null,
  paintBars: null as (() => void) | null,
  reset() {
    this.track = null;
    this.bands = [];
    this.sens = 1;
  },
};
