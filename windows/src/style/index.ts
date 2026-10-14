// Order matters: the pieces are the original style.css, cut at its section headers, and
// keep its cascade order. ui.css (shared pieces) first, then core, then overview and settings.
// Module sheets are NOT here: each module imports its own CSS from its index.ts. They load
// AFTER these (modules/index is imported after ./style), see docs/MODULES-CONTRACT.md.
import "./ui.css";
import "./core.css";
import "./overview.css";
import "./settings.css";
