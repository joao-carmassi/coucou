import { command, commandOrThrow } from "../../core/bridge";


export const ClaudeBridge = {
  openInVSCode: (path: string | null, wslDistro: string | null = null) =>
    command<boolean>("claude_open_in_vscode", { path, wslDistro }),
  openClaudeApp: () => command<void>("claude_open_app"),
  openTerminal: (path: string | null, wslDistro: string | null, terminalPids: number[]) =>
    command<boolean>("claude_open_terminal", { path, wslDistro, terminalPids }),
  startClaudeTerminal: () => command<boolean>("claude_start_terminal"),
  hooksStatus: (configDir?: string) => command<HookStatus>("claude_hooks_status", { configDir }),
  hooksPreview: (install: boolean, configDir?: string) =>
    commandOrThrow<HookPreview>("claude_hooks_preview", { install, configDir }),
  hooksApply: (install: boolean, fingerprint: string, configDir?: string) =>
    commandOrThrow<string>("claude_hooks_apply", { install, fingerprint, configDir }),
  claudeProfiles: () => command<ClaudeProfile[]>("claude_profiles"),
  sessionsAll: () => command<ManagedSession[]>("claude_sessions_all"),
  sessionsLive: () => command<LiveSession[]>("claude_sessions_live"),
  sessionLaunch: (r: LaunchRequest) =>
    commandOrThrow<void>("claude_session_launch", { profile: r.profile, cwd: r.cwd, resume: r.resume, attach: r.attach, prompt: r.prompt ?? null }),
  sessionErase: (profile: string, id: string) => commandOrThrow<void>("claude_session_erase", { profile, id }),
  wslDistros: () => command<string[]>("claude_wsl_distros"),
  wslStatus: (distro: string) => commandOrThrow<WslStatus>("claude_wsl_status", { distro }),
  wslHooksPreview: (distro: string, install: boolean) =>
    commandOrThrow<HookPreview>("claude_wsl_hooks_preview", { distro, install }),
  wslHooksApply: (distro: string, install: boolean, fingerprint: string) =>
    commandOrThrow<string>("claude_wsl_hooks_apply", { distro, install, fingerprint }),
  approvalDecision: (requestId: string, decision: "allow" | "deny" | "skip" | "plan-keep" | "plan-manual" | "plan-auto") =>
    command<void>("claude_approval_decision", { requestId, decision }),
  approvalAck: (requestId: string) => command<void>("claude_approval_ack", { requestId }),
  approvalDecline: (requestId: string) => command<void>("claude_approval_decline", { requestId }),
  approvalAnswer: (requestId: string, answers: Record<string, string>) =>
    command<void>("claude_approval_answer", { requestId, answers }),
  resumeInTerminal: (id: string, cwd: string | null) =>
    commandOrThrow<void>("claude_resume_in_terminal", { id, cwd }),
};


export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
  /** Claude Code on Windows, if installed. */
  claudeCli: string | null;
}

export interface WslStatus {
  distro: string;
  installed: boolean;
  /** Linux paths, as the user knows them. */
  settingsPath: string;
  relayPath: string;
  relayReady: boolean;
  /** Claude Code inside the distro, if installed. */
  claudeCli: string | null;
  /** The distro could not be reached; nothing else is meaningful then. */
  error: string | null;
}

export interface ClaudeProfile { key: string; label: string; configDir: string; isDefault: boolean }

export interface ManagedSession {
  id: string; cwd: string; title: string; updated: number; profile: string;
  status: "running" | "offline"; activity: string | null; pid: number | null;
}

export interface LiveSession { profile: string; id: string; pid: number; activity: string | null }

export interface LaunchRequest { profile: string; cwd: string | null; resume: string | null; attach: string | null; prompt?: string | null }

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

