// Order matters: the pieces are the original style.css, cut at its section headers, and
// keep its cascade order. ui.css (shared pieces) first; each module imports its own CSS.
import "./ui.css";
import "./core.css";
import "./overview.css";
import "./settings.css";
