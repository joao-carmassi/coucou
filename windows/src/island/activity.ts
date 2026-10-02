import type { ClaudeSession } from "../core/state";

const plural = (n: number) => `${n} agent${n > 1 ? "s" : ""}`;
const base = (p: string) => p.split(/[\\/]/).pop() || p;

/** One line on what Claude is doing now, for the compact island. "" = nothing to say. */
export function activityLine(s: ClaudeSession | undefined): string {
  if (!s) return "";
  if (s.approval || s.question) return "esperando você";
  if (s.agentsRunning > 0) {
    return s.agentsRunning === s.agentsLaunched ? `chamando ${plural(s.agentsRunning)}` : `faltam ${plural(s.agentsRunning)}`;
  }
  const step = [...s.steps].reverse().find((x) => x.state === "running");
  if (step) {
    const t = step.tool;
    if (t === "WebSearch" || t === "WebFetch") return "pesquisando na web";
    if (t === "Bash" || t === "PowerShell") return "rodando comando";
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(t)) {
      return step.target ? `editando ${base(step.target)}` : "editando arquivo";
    }
    if (["Read", "Grep", "Glob"].includes(t)) return "lendo código";
    if (t === "Agent" || t === "Task") return "chamando agent";
    if (t.startsWith("mcp__")) return "usando MCP";
    return `usando ${t}`;
  }
  if (s.state === "thinking") return "pensando";
  if (s.state === "working") return "trabalhando";
  if (s.state === "finished") return "pronto";
  return "";
}
