import { ICONS as CORE } from "../../kit/icons";
// Glyphs only the Claude module draws (a session's steps: a prompt, an edit, a command, a search), stroked.
export const ICONS = {
  ...CORE,
  // bubble.left.fill
  bubble: "M12 3.6c-5 0-9 3.3-9 7.4 0 2.3 1.3 4.4 3.3 5.7-.2 1.2-.8 2.4-1.7 3.4 1.9-.2 3.6-.9 4.9-1.9 .8.2 1.6.3 2.5.3 5 0 9-3.3 9-7.5s-4-7.4-9-7.4z",
  // A session's steps, stroked: an edit, a command, a search.
  pencil: "M4.5 19.5l1-4.2L16.6 4.2l3.2 3.2L8.7 18.5l-4.2 1zM14.4 6.4l3.2 3.2",
  terminal: "M5 7.5 9.5 12 5 16.5M12.5 17H19",
  search: "M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12M15 15l4.5 4.5",
} as const;
