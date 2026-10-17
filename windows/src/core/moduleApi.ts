// Module contract: types only, plus resolveEnabled. Only `import type` here (Node loads it in tests).

import type { BotEmoteName, BotStateName, IslandMode, ViewLayout } from "./layout";
import type { EmoteDef, MoodDef } from "../mochi/moods";
import type { RequestSpec } from "./requests";
import type { ModuleSettings } from "./moduleSettings";
import type { Pill, PillAt, PillInput } from "./state";
import type { FsmState } from "../island/fsm";
import type { ViewActions } from "../views/views";

export type { Pill } from "./state";
export type Disposer = () => void;

/** Optional neutral priority bands for status lines and avatar signals (any number works). */
export const BAND = { URGENT: 90, NOTICE: 60, PINNED: 35, ACTIVE: 30, AMBIENT: 10 } as const;

/** The window is a fixed PANEL_W x PANEL_H; the expanded island is EXPANDED_W wide. core/layout re-exports both. */
export const PANEL_H = 320;
export const EXPANDED_W = 640;

/** A Mochi built by api.mochi.free: ticked by the island until its element leaves the document. */
export interface FreeMochi { el: HTMLElement; set(color: string, mood: BotStateName): void }
/** A Mochi drawn on a canvas the module owns; the module ticks it. `emote` ms defaults to 1800. */
export interface MochiSprite {
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  setState(m: BotStateName, instant?: boolean): void;
  emote(e: BotEmoteName, ms?: number): void;
  color(hex: string | null): void;
}

/** Higher wins, tie goes to the most recent. Suggested bands: BAND below; who uses which number is in docs/MODULES-CONTRACT.md. */
export interface StatusLine {
  priority: number;
  text: string;
  icon?: string;
  ttlMs?: number;
  urgent?: boolean;
  /** Shown beside other pills in place of the mini grid. Default: only when no other pill. */
  overGrid?: boolean;
  /** Richer compact line: `text` is the first line, beside a small cover, a second line and a trailing text (a time). */
  card?: StatusCard;
  /** A click on the compact island while this line is shown opens this view (source lines get their source's `view`). */
  view?: string;
  /** Dimmed (paused). Cards dim through `card.dim`. */
  dim?: boolean;
  /** Plain text: no shimmer, no entrance animation, no idle frames. Set by the core on source lines; the text swaps instantly. */
  still?: boolean;
}

/** A one-line source a module registers (api.status.source): shown when the user pinned it, or while it is the last module opened. */
export interface SourceDef {
  /** Pt-BR name of the line, for the settings window and tooltips. */
  label: string;
  /** Opened by a click on the line. */
  view?: string;
}
/** `set(line)` publishes (null = no content); `ttlMs` and `priority` of a source line are ignored: the core assigns the band. */
export interface StatusSource { set(line: StatusLine | null): void; dispose: Disposer }

/** Image URL / data URL (null: a neutral square), second line, trailing text, dimmed (paused). All optional. */
export interface StatusCard { art?: string | null; sub?: string; trail?: string; dim?: boolean }

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
/** A short line on the compact island (api.island.notice). */
export interface Notice {
  text: string;
  /** BAND scale; >= BAND.URGENT ignores presence quiet. Default BAND.NOTICE. */
  priority?: number;
  /** On-screen time once shown; default 4000, clamped to 1500..600000 (api.island.focusMs() for "until the island hides"). */
  ms?: number;
  /** The same owner + key replaces in place (the on-screen time restarts). */
  key?: string;
  /** A click on the compact island while this is shown opens this view. */
  view?: string;
  /** May reveal a hidden island to compact (never while presence is quiet, unless urgent). */
  peek?: boolean;
  /** Shown as the richer compact card (cover, second line, trailing text) instead of the plain `text`. */
  card?: StatusCard;
}
/** A command (api.actions.add); with `key`, run by Alt+<key>. */
export interface ActionDef {
  /** Local id; the core stamps "<moduleId>.<id>". */
  id: string;
  title: string;
  keywords?: readonly string[];
  /** One [a-z0-9]: Alt+<key> while the island has the keyboard. The first to claim it keeps it; duplicates warn. */
  key?: string;
  /** Not offered (shortcut) while this says false. */
  when?(): boolean;
  /** A throw or rejection goes to api.island.error. */
  run(): void | Promise<void>;
}
/** A read-only view of a registered action: no `run` closure leaves its module. */
export interface ActionInfo { key: string; title: string; owner: string; keyHint?: string }
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
  /** The core notice queue: see api.island.notice. `owner` is the module id. */
  addNotice(owner: string, n: Notice): Disposer;
  hide(): void;
  collapse(): void;
  reveal(): void;
  reopen(): void;
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
  avatarLevel(v: number, opts?: { dance?: boolean }): void;
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
  listen<T>(event: string, fn: (payload: T) => void): Disposer;
  timeout(fn: () => void, ms: number): Disposer;
  interval(fn: () => void, ms: number, opts?: { whenVisible?: boolean }): Disposer;
  status: {
    set(line: StatusLine | null): void;
    /**
     * Registers a one-line source "<moduleId>.<key>" (key: [a-z0-9-]+; registering it again replaces it; removed when the module stops).
     * Its line is shown at BAND.PINNED while the user pinned it (setting `pinnedLine`, one at a time, over any agent line but under
     * notices and alerts), and at the ambient band while this module is the last one the user opened (until the island hides).
     * The pin is dropped by itself when the source has had no content for 5 minutes.
     */
    source(key: string, def: SourceDef): StatusSource;
    /** True while the user pinned this module's source `key`. */
    pinned(key: string): boolean;
    /** True while the user pinned any source line (of any module). */
    anyPinned(): boolean;
    /** Pins (on) or releases (off) this module's source `key`; pinning replaces any other pinned line. */
    pin(key: string, on: boolean): void;
  };
  avatar: { publish(sig: AvatarSignal | null): void;
    /** The glow behind Mochi for a mood (colour and opacity); idle's for an unknown name. */
    glow(mood: string): { color: string; opacity: number }; emote(e: BotEmoteName): void; morph(v: number): void; gulp(): void; tint(color: string | null): void; bodyColor(): string | null;
    /** Loudness 0..1 (squash <= 6 %); calls under 33 ms apart are dropped, it decays to 0 in 300 ms. 0 / never = inert. */
    /** Loudness 0..1 squashes Mochi a little; {dance:true} also hops and sways it (a beat-driven bounce). */
    level(v: number, opts?: { dance?: boolean }): void;
    /**
     * Defines a Mochi mood of this module and returns its name, "<moduleId>.<local>": use that name in avatar.publish,
     * pills.set and mochi.free/sprite. Removed when the module stops (anything still wearing it draws as idle).
     */
    defineMood(local: string, def: MoodDef): `${string}.${string}`;
    /** Defines an emote of this module and returns its name, "<moduleId>.<local>", for avatar.emote / avatar.publish / a pill's emote. Removed when the module stops. */
    defineEmote(local: string, def: EmoteDef): `${string}.${string}`;
  };
  /**
   * Pills (mini Mochis) this module owns; all removed when it stops. set creates (label + color) or patches.
   * `focus` puts one of its pills in front (the pill being opened, during a `pillOpen` reaction, is allowed too); another
   * module's pill is refused. The first pill is focused by the core, and when the front pill goes the core moves focus to
   * the first one left. The returned function gives the front back to the pill it took it from, if it still holds it.
   */
  pills: {
    set(pill: PillInput, at?: PillAt): void; remove(id: string): void; focus(id: string): Disposer;
    /** Every pill, in order (all modules'): read-only. */
    all(): readonly Pill[];
    get(id: string): Pill | null;
    /** The pill in front (the first one when none was focused), or null. */
    front(): Pill | null;
    /** Every pill but the front one. */
    others(): readonly Pill[];
  };
  /** Plays a sound by name (SOUND_NAMES in core/sound.ts, or one registered); a name that is not loaded stays silent. */
  sound: {
    play(name: string): void;
    /** Adds a sound from a same-origin URL (throws otherwise) and returns its name, "<moduleId>.<local>". Removed when the module stops. */
    register(local: string, url: string): string;
  };
  mochi: {
    /** A mini Mochi whose body is `size` CSS px across, in the pill's colour and mood. Ticked by the island until detached. */
    mini(pill: Pill, size: number): HTMLElement;
    /** A mini Mochi that stands for something other than a pill; `set` changes its look. `eyes` scales the eyes. */
    free(color: string, mood: BotStateName, size: number, eyes?: number): FreeMochi;
    /** A Mochi for a canvas of the module's own. `overhang`: px of canvas above the body that particles may use. */
    sprite(opts?: { overhang?: number }): MochiSprite;
  };
  island: {
    /** Navigation: unfolds the island on `view`. It never pins; to hold the island open use `request`. */
    open(view: string): void;
    /**
     * Sticky focus for a running task: every reopen lands on `view` instead of the home view, however long the island stayed closed.
     * Released by the disposer (call it when the task is over, or from an action that should end the focus), by this module stopping,
     * by the user picking the home view, or, only when `idleMs` is given, after the view goes unseen that long.
     * It beats the implicit focus (the last view left, kept for the user's focus time). It never pins the island and never opens it.
     */
    hold(view: string, opts?: { idleMs?: number }): Disposer;
    /**
     * Asks for the screen. The core keeps one list (highest priority in front, the newest wins a tie; cleaned when this module stops).
     * A request below the front one is queued: the view does not switch. Disposing the front shows the next one's view (island still open), else the island may auto-close again.
     * `pin` holds the island open (no auto-close, Esc or click-outside) while it is in front. `ms` disposes it by itself.
     */
    request(spec: RequestSpec): Disposer;
    /**
     * A short line on the compact island, queued with the other modules' (highest priority first, then oldest; 12 at most).
     * It shows only while the island is compact and no stronger status line or request is up; its on-screen time starts when it shows.
     * Hidden or open island: it waits (60 s at most) unless `peek` reveals the compact island. Not shown while the user is in a
     * full-screen app or a call (setting "Ocultar durante tela cheia e chamadas"), except `priority >= BAND.URGENT`.
     * Dropped by the disposer, by this module stopping and by Pause (while paused the call is a no-op).
     */
    notice(n: Notice): Disposer;
    /** The user's focus time in ms: how long the minimized island stays up before hiding (60 s when it never hides). */
    focusMs(): number;
    /** True while any pinned request exists (a note over it would be rude). */
    busy(): boolean;
    setView(view: string): void; close(): void; wake(): void; hide(): void;
    /** Unfolds a folded or hidden island the way a click on it does (request, held task, home); an open one stays as it is. */
    reopen(): void;
    keepAwake(pred: () => boolean): Disposer; mode(): IslandMode; fsmState(): FsmState; mouseInside(): boolean; view(): string;
    note(text: string): void; error(err: unknown): void; overlay(o: Overlay): Disposer;
    /** Fires after every change of the island's state (pills, mode, view, requests...); removed when the module stops. */
    onChange(fn: () => void): Disposer;
    /** The view the island rests on (what the strongest module asks for, else "empty"), read live. */
    home(): string;
    /** The cursor in logical screen pixels. */
    mouse(): { x: number; y: number };
    /** The cursor relative to the island's top-left corner. */
    mouseLocal(): { x: number; y: number };
    /** Asks for a redraw on the next frame. */
    redraw(): void;
  };
  actions: {
    /** Adds a command (Alt+<key> when it has a `key`); removed by the disposer or when this module stops. */
    add(def: ActionDef): Disposer;
    /** Every action allowed now, any owner. */
    all(): readonly ActionInfo[];
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
  /** Preset ids that switch the module on (manifest.json). */
  presets?: string[];
  /** Settings keys that belong to this machine (paths, install state): Hub import never applies them. */
  machineKeys?: string[];
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
/** What the settings window lends a section: timers it clears when the section is rebuilt or the window unloads. */
export type SettingsUi = { timeout(fn: () => void, ms: number): void };
export type SettingsSection = (settings: ModuleSettings, ui: SettingsUi) => { el: HTMLElement; dispose?(): void };
