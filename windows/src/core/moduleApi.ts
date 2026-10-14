// Module contract: types only, plus resolveEnabled. Only `import type` here (Node loads it in tests).

import type { BotEmoteName, BotStateName, IslandMode, ViewLayout } from "./layout";
import type { RequestSpec } from "./requests";
import type { ModuleSettings } from "./moduleSettings";
import type { PillAt, PillInput } from "./state";
import type { FsmState } from "../island/fsm";
import type { ViewActions } from "../views/views";

export type Disposer = () => void;

/** Optional neutral priority bands for status lines and avatar signals (any number works). */
export const BAND = { URGENT: 90, NOTICE: 60, ACTIVE: 30, AMBIENT: 10 } as const;

/** Higher wins, tie goes to the most recent. Suggested bands: BAND below; who uses which number is in docs/MODULES-CONTRACT.md. */
export interface StatusLine {
  priority: number;
  text: string;
  icon?: string;
  ttlMs?: number;
  urgent?: boolean;
  /** Shown beside other pills in place of the mini grid. Default: only when no other pill. */
  overGrid?: boolean;
}

export interface AvatarSignal { state: BotStateName; priority: number; emote?: BotEmoteName; ttlMs?: number }

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** How tall the island should be for what the view holds now, when that varies. */
  readonly height?: number;
}

export interface ViewContext { actions: ViewActions; onResize(): void; api: IslandApi }
export interface ViewDef { name: string; layout: ViewLayout; tabOf?: string; lightsHome?: true; keyboard?: boolean; build(ctx: ViewContext): ViewHost }
/** `home`: this tab is the home (the header's first stop, and where a view that `lightsHome` highlights). */
export interface TabDef { view: string; title: string; icon(): Element; order: number; home?: true }
export interface Overlay {
  el: HTMLElement;
  active(): boolean;
  /** Draws; true while it needs another frame. */
  frame(nowMs: number): boolean;
  /** True while it holds the pointer (a drag in progress): the island skips hover/auto-close bookkeeping. */
  cursor?(x: number, y: number, down?: boolean): boolean | void;
  place?(islandW: number): void;
  leaving?(nextView: string): void;
}
export type { RequestSpec };
/** Where home is (hover / click on the compact island); to hold the island open on a card use api.island.request. */
export interface HomeRequest { view: string; priority: number }
export interface IslandHooks {
  homeView(): HomeRequest | null;
  keepAwake(): boolean;
  /** The pill `taskId` was opened (its arrow); true when a module took it. */
  pillOpen(taskId: string): boolean;
  /** Mochi was clicked; true when a module took the click (no slap). */
  avatarClick(): boolean;
  /** Mochi was pulled out of the island. */
  avatarPull(): void;
}

/** What Island lends the registry. */
export interface IslandHost {
  readonly actions: ViewActions;
  open(view: string): void;
  /** The core queue: see api.island.request. `owner` is the module id. */
  addRequest(owner: string, spec: RequestSpec): Disposer;
  hide(): void;
  collapse(): void;
  reveal(): void;
  setView(view: string): void;
  note(text: string): void;
  error(err: unknown): void;
  mouseInside(): boolean;
  fsmState(): FsmState;
  layoutHint(): void;
  redraw(): void;
  addView(def: ViewDef, ctx: ViewContext): Disposer;
  setTabs(tabs: TabDef[]): void;
  addOverlay(o: Overlay): Disposer;
  avatarEmote(e: BotEmoteName): void;
  avatarMorph(v: number): void;
  avatarGulp(): void;
  avatarTint(color: string | null): void;
  avatarBodyColor(): string | null;
}

export interface IslandApi {
  readonly id: string;
  /**
   * A read-only snapshot of this module's own settings: the keys of its manifest `settingsDefaults`, missing ones filled
   * from the defaults. Read it again to see saves; State.settings is not for modules.
   */
  settings<T extends object = Record<string, unknown>>(): Readonly<T>;
  /**
   * Saves only the given keys (they must be in this module's `settingsDefaults`; others throw). The core merges them onto the
   * stored settings, so the settings window or another module saving other keys never undoes this. `settings()` has them at once.
   */
  saveSettings(patch: Record<string, unknown>): Promise<void>;
  /** The tray's Pause is on: pollers and alerts should stay quiet. */
  paused(): boolean;
  /** Fires with the new value every time Pause flips. */
  onPause(fn: (paused: boolean) => void): Disposer;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null>;
  listen<T>(event: string, fn: (payload: T) => void): Disposer;
  timeout(fn: () => void, ms: number): Disposer;
  interval(fn: () => void, ms: number, opts?: { whenVisible?: boolean }): Disposer;
  status: { set(line: StatusLine | null): void };
  avatar: { publish(sig: AvatarSignal | null): void; emote(e: BotEmoteName): void; morph(v: number): void; gulp(): void; tint(color: string | null): void; bodyColor(): string | null };
  /**
   * Pills (mini Mochis) this module owns; all removed when it stops. set creates (label + color) or patches.
   * `focus` puts one of its pills in front (the pill being opened, during a `pillOpen` reaction, is allowed too); another
   * module's pill is refused. The first pill is focused by the core, and when the front pill goes the core moves focus to
   * the first one left. The returned function gives the front back to the pill it took it from, if it still holds it.
   */
  pills: { set(pill: PillInput, at?: PillAt): void; remove(id: string): void; clear(): void; focus(id: string): Disposer };
  /** Adds a sound under `name` (url of a WAV); removed when the module stops. */
  sound: { register(name: string, url: string): Disposer };
  island: {
    /** Navigation: unfolds the island on `view`. It never pins; to hold the island open use `request`. */
    open(view: string): void;
    /**
     * Asks for the screen. The core keeps one list (highest priority in front, the newest wins a tie; cleaned when this module stops).
     * A request below the front one is queued: the view does not switch. Disposing the front shows the next one's view (island still open), else the island may auto-close again.
     * `pin` holds the island open (no auto-close, Esc or click-outside) while it is in front. `ms` disposes it by itself.
     */
    request(spec: RequestSpec): Disposer;
    /** True while any pinned request exists (a note over it would be rude). */
    busy(): boolean;
    setView(view: string): void; close(): void; wake(): void; hide(): void;
    keepAwake(pred: () => boolean): Disposer; isVisible(): boolean; mode(): IslandMode; fsmState(): FsmState; mouseInside(): boolean; view(): string;
    note(text: string): void; error(err: unknown): void; layoutHint(): void; redraw(): void; overlay(o: Overlay): Disposer;
  };
  provide<K extends keyof IslandHooks>(hook: K, fn: IslandHooks[K]): Disposer;
  /** Offers a service under a namespaced key ("<module>.<name>"; the types live in that module's api.ts). Removed when this module stops. */
  provide<T>(service: `${string}.${string}`, impl: T): Disposer;
  /** The first provider of a service, or undefined: a missing service means the feature is absent. */
  use<T>(service: `${string}.${string}`): T | undefined;
  /** Every provider of a service. */
  useAll<T>(service: `${string}.${string}`): T[];
  call<K extends keyof IslandHooks>(hook: K, ...args: Parameters<IslandHooks[K]>): ReturnType<IslandHooks[K]> | undefined;
  onVisibility(fn: (mode: IslandMode, prev: IslandMode) => void): Disposer;
}

export interface ModuleInfo {
  id: string; label: string; defaultEnabled: boolean; requires?: string[];
  /** Settings heading the module is listed under. */
  group?: string;
  /** The module's keys in the flat settings.json, with their defaults (manifest.json). New keys start with the module id. */
  settingsDefaults?: Record<string, unknown>;
}
/** Behaviour only: label, default, requirements and group live in the module's manifest.json. */
export interface ModuleDef {
  id: string;
  views?: ViewDef[];
  tabs?: TabDef[];
  start(api: IslandApi): Disposer | void;
}

export function resolveEnabled(catalog: readonly ModuleInfo[], stored: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of catalog) out[m.id] = (stored[m.id] ?? m.defaultEnabled) && (m.requires ?? []).every((r) => out[r] === true);
  return out;
}

/** A module's section of the settings window; it exists only while the module is on. */
export type SettingsSection = (settings: ModuleSettings) => { el: HTMLElement; dispose?(): void };
