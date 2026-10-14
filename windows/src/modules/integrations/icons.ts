import { ICONS as CORE } from "../../views/icons";
// Glyphs only the service modules draw, stroked unless noted: pass `{ stroke: 2 }` to svg().
export const ICONS = {
  ...CORE,
  // star.fill
  star: "M12 3.2l2.6 5.55 5.9.82-4.3 4.3 1.05 6.13L12 17.1l-5.25 2.9L7.8 13.87 3.5 9.57l5.9-.82L12 3.2z",
  // square.stack.fill
  stack: "M5 8h14v11.5H5V8zm1.8-3h10.4v1.6H6.8V5zm1.6-2.6h7.2V4H8.4V2.4z",
  // GitHub panel — no SF Symbol to mirror, so these are drawn for stroke
  // rendering: pass `{ stroke: 2 }` to svg().
  // arrow.clockwise
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.5H15",
  // a commit: a node on a line
  commit: "M12 9a3 3 0 1 1 0 6 3 3 0 1 1 0-6M3 12h6M15 12h6",
  // pull request: two branches, the right one pointing back
  pullRequest: "M6 4a2 2 0 1 1 0 4 2 2 0 1 1 0-4M6 16a2 2 0 1 1 0 4 2 2 0 1 1 0-4M6 8v8M18 16a2 2 0 1 1 0 4 2 2 0 1 1 0-4M18 16V9a3 3 0 0 0-3-3h-3M14 3.5 11.5 6 14 8.5",
  // merge: a branch folding back in
  merge: "M6 4a2 2 0 1 1 0 4 2 2 0 1 1 0-4M6 16a2 2 0 1 1 0 4 2 2 0 1 1 0-4M18 10a2 2 0 1 1 0 4 2 2 0 1 1 0-4M6 8v8M6 8c0 2.5 2.5 4 10 4",
  // issue: a ring with a dot
  issue: "M12 4a8 8 0 1 1 0 16 8 8 0 1 1 0-16M12 11.2a.8.8 0 1 1 0 1.6.8.8 0 1 1 0-1.6",
  // tag
  tag: "M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9zM8 7.5h.01",
  // plus, stroked
  add: "M12 5v14M5 12h14",
  // lock, stroked
  lock: "M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9H6z",
  // minus, stroked
  dash: "M7 12h10",
  // a rocket, for deployments, stroked
  rocket: "M12 3c3 2.2 4.5 5.2 4.5 9l-1.8 3h-5.4l-1.8-3c0-3.8 1.5-6.8 4.5-9zM12 9.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 1 1 0-3.2M9.3 15l-1.8 4.5 2.8-1.6M14.7 15l1.8 4.5-2.8-1.6",
  // What was said: a speech bubble, drawn as a line like the other GitHub marks.
  comment: "M4 5.5h16v10.5h-8.5L7 20v-4H4z",
  // A bell, and a bell struck through, stroked: a project that speaks up, one that keeps quiet.
  bell: "M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14zM10 20.5a2 2 0 0 0 4 0",
  bellOff: "M6.5 16.5V11a5.5 5.5 0 0 1 9-4.2M17.5 11.5v5l1.5 2H8M10 20.5a2 2 0 0 0 4 0M4.5 4.5l15 15",
} as const;
