// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function command<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  /** Which modules are on (resolved by Rust). */
  modules: Record<string, boolean>;
}

export const Bridge = {
  boot: () => command<BootInfo>("boot"),

  saveSettings: (settings: Settings) => command<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => command<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    command<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus and take it away again. */
  focusWindow: (focused: boolean) => command<void>("focus_window", { focused }),

  reposition: () => command<void>("reposition"),

  openUrl: (url: string) => command<void>("open_url", { url }),

  quit: () => command<void>("quit_app"),

  openSettingsWindow: () => command<void>("open_settings_window"),

  /** The section the settings window was opened for, once ("" for none). */
  takeSettingsSection: () => command<string>("take_settings_section"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => command<void>("log_line", { message }),

  /** Tray → Pause. */
  setPaused: (paused: boolean) => command<void>("set_paused", { paused }),

  // ── Claude module (claude): hooks, sessions, approvals, WSL ───────────────
  openInVSCode: (path: string | null, wslDistro: string | null = null) =>
    command<boolean>("open_in_vscode", { path, wslDistro }),
  openClaudeApp: () => command<void>("open_claude_app"),
  openTerminal: (path: string | null, wslDistro: string | null, terminalPids: number[]) =>
    command<boolean>("open_terminal", { path, wslDistro, terminalPids }),
  startClaudeTerminal: () => command<boolean>("start_claude_terminal"),
  hooksStatus: (configDir?: string) => command<HookStatus>("hooks_status", { configDir }),
  hooksPreview: (install: boolean, configDir?: string) =>
    commandOrThrow<HookPreview>("hooks_preview", { install, configDir }),
  hooksApply: (install: boolean, fingerprint: string, configDir?: string) =>
    commandOrThrow<string>("hooks_apply", { install, fingerprint, configDir }),
  claudeProfiles: () => command<ClaudeProfile[]>("claude_profiles"),
  sessionsAll: () => command<ManagedSession[]>("sessions_all"),
  sessionsLive: () => command<LiveSession[]>("sessions_live"),
  sessionLaunch: (r: LaunchRequest) =>
    commandOrThrow<void>("session_launch", { profile: r.profile, cwd: r.cwd, resume: r.resume, attach: r.attach, prompt: r.prompt ?? null }),
  sessionErase: (profile: string, id: string) => commandOrThrow<void>("session_erase", { profile, id }),
  wslDistros: () => command<string[]>("wsl_distros"),
  wslStatus: (distro: string) => commandOrThrow<WslStatus>("wsl_status", { distro }),
  wslHooksPreview: (distro: string, install: boolean) =>
    commandOrThrow<HookPreview>("wsl_hooks_preview", { distro, install }),
  wslHooksApply: (distro: string, install: boolean, fingerprint: string) =>
    commandOrThrow<string>("wsl_hooks_apply", { distro, install, fingerprint }),
  approvalDecision: (requestId: string, decision: "allow" | "deny" | "skip" | "plan-keep" | "plan-manual" | "plan-auto") =>
    command<void>("approval_decision", { requestId, decision }),
  approvalAck: (requestId: string) => command<void>("approval_ack", { requestId }),
  approvalDecline: (requestId: string) => command<void>("approval_decline", { requestId }),
  approvalAnswer: (requestId: string, answers: Record<string, string>) =>
    command<void>("approval_answer", { requestId, answers }),
  resumeInTerminal: (id: string, cwd: string | null) =>
    commandOrThrow<void>("resume_in_terminal", { id, cwd }),
  /** Copies a file into the inbox (the only place a session may attach from). */
  ingestClaudeFile: (path: string) => commandOrThrow<ClaudeInboxFile>("ingest_file", { path }),

  // ── Voice module (voice) ──────────────────────────────────────────────────
  voiceStart: () => commandOrThrow<void>("voice_start"),
  voiceStop: () => command<void>("voice_stop"),
  voiceModelStatus: () => command<VoiceStatus>("voice_model_status"),
  voiceDownloadModel: () => commandOrThrow<void>("voice_download_model"),
};

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  /** `end`: the drag finished without a drop on the island. */
  type: "enter" | "over" | "drop" | "leave" | "end";
  paths?: string[];
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 * Comes from Coucou's own drop target (drop_target.rs), not Tauri's: WebView2
 * replaces the one wry installs with a target that refuses every file.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

// ── Claude module types (shapes of the Rust commands at m3-ok) ──────────────

/** Same as `command`, but surfaces the error so the UI can show what went wrong. */
async function commandOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export interface ClaudeInboxFile { name: string; path: string; size: number }

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

export interface VoiceStatus { ready: boolean; listening: boolean; hotkeyError: string }
