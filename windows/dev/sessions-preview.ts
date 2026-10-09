// Dev harness: the sessions view on sample data with Bridge stubbed out.
// Not part of the app bundle.

import "../src/style.css";
import { Bridge, type ManagedSession } from "../src/core/bridge";
import { State } from "../src/core/state";
import { buildSessionsView } from "../src/views/sessions";

const ago = (min: number) => Date.now() - min * 60_000;
const mk = (id: string, cwd: string, title: string, min: number, profile: string, status: "running" | "offline"): ManagedSession =>
  ({ id, cwd, title, updated: ago(min), profile, status, activity: null, pid: status === "running" ? 1 : null });
const sessions = [
  mk("1", "C:\dev\web-app", "Fix the login redirect loop", 3, "a", "running"),
  mk("2", "C:\dev\api", "Add pagination to /orders", 55, "b", "offline"),
  mk("3", "C:\dev\docs", "Rewrite the install guide", 60 * 26, "a", "offline"),
];
Object.assign(Bridge, {
  claudeProfiles: async () => [
    { key: "a", label: "Pessoal", configDir: "", isDefault: true },
    { key: "b", label: "Trabalho", configDir: "", isDefault: false },
  ],
  sessionsAll: async () => sessions,
  sessionsLive: async () => [],
});
State.mode = "expanded";
State.view = "prompt";

const view = buildSessionsView(() => {});
view.el.classList.add("on");
const frame = document.createElement("div");
frame.className = "frame";
const views = document.createElement("div");
views.style.cssText = "position:absolute;left:10px;right:10px;top:42px;bottom:10px";
views.append(view.el);
frame.append(views);
document.body.append(frame);
view.sync();
