// Order matters: the pieces are the original style.css, cut at its section headers, and
// keep its cascade order. ui.css (shared pieces) first, then core, then the generic text blocks,
// the panel kit, the code view and settings.
// Module sheets are NOT here: each module imports its own CSS from its index.ts. They load
// AFTER these (modules/index is imported after ./style), see docs/MODULES-CONTRACT.md.
import "./ui.css";
import "./core.css";
import "./text.css";
import "../kit/pane.css";
import "../kit/code.css";
import "./settings.css";
