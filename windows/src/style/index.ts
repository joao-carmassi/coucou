// Order matters: the pieces are the original style.css, cut at its section headers, and
// keep its cascade order. ui.css (shared pieces) first, then core, then every module sheet.
// Module sheets load AFTER the shared ones (a module chunk would otherwise be emitted first and
// lose same-specificity ties such as .sess-newbtn vs .btn), in the old style.css order:
// claude, upload, integrations, media, timer.
import "./ui.css";
import "./core.css";
import "./overview.css";
import "./settings.css";
import "../modules/claude/base.css";
import "../modules/claude/chat.css";
import "../modules/claude/panel.css";
import "../modules/claude/claude.css";
import "../modules/upload/upload.css";
import "../modules/media/media.css";
import "../modules/timer/timer.css";

// Integrations: the GitHub panel and the integration cards (loaded last, as in the old style.css).
import "../modules/integrations/integrations.css";
