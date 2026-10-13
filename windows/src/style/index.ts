// Order matters: the pieces are the original style.css, cut at its section headers, and
// keep its cascade order. ui.css (shared pieces) first; each module imports its own CSS.
import "./ui.css";
import "./core.css";
import "./overview.css";
import "./settings.css";
// Module sheets load AFTER the shared ones (a module chunk would otherwise be emitted first and
// lose same-specificity ties such as .sess-newbtn vs .btn). Same order as the old style.css.
import "../modules/claude/base.css";
import "../modules/claude/chat.css";
import "../modules/claude/panel.css";
import "../modules/claude/claude.css";
import "../modules/timer/timer.css";
// Module sheets load AFTER the shared ones (a module chunk would otherwise be emitted first and
// lose same-specificity ties such as .sess-newbtn vs .btn). Same order as the old style.css.
import "../modules/claude/base.css";
import "../modules/claude/chat.css";
import "../modules/claude/panel.css";
import "../modules/claude/claude.css";
import "../modules/timer/timer.css";
import "../modules/upload/upload.css";
