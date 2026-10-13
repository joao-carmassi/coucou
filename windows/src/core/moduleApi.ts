// Module contract: types only, plus resolveEnabled. Only `import type` here (Node loads it in tests).

import type { BotEmoteName, BotStateName, IslandMode, ViewLayout } from "./layout";
import type { Settings } from "./state";
import type { FsmState } from "../island/fsm";
import type { ViewActions } from "../views/views";

export type Disposer = () => void;

/** Higher wins, tie goes to the most recent. approval 100, question 90, error 80, finished 60, timer 50, voice 40, Claude activity 30, media 20, integrations 10. */
export interface StatusLine {
  priority: number;
  text: string;
  icon?: string;
  ttlMs?: number;
  urgent?: boolean;
  /** Shown beside other pills in place of the mini grid (the timer). Default: only when no other pill. */
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
export interface ViewDef { name: string; layout: ViewLayout; tabOf?: string; keyboard?: boolean; build(ctx: ViewContext): ViewHost }
export interface TabDef { view: string; title: string; icon(): Element; order: number }
export interface Overlay {
  el: HTMLElement;
  active(): boolean;
  /** Draws; true while it needs another frame. */
  frame(nowMs: number): boolean;
  cursor?(x: number, y: number): void;
  place?(islandW: number): void;
  leaving?(nextView: string): void;
}
export interface HomeRequest { view: string; pin: boolean; priority: number }
export interface IslandHooks {
  homeView(): HomeRequest | null;
  keepAwake(): boolean;
  openTarget(taskId: string): boolean;
  followNews(): boolean;
  mochiDrop(): void;
  launchFile(path: string, ingest: boolean): Promise<void>;
}

/** What Island lends the registry. */
export interface IslandHost {
  readonly actions: ViewActions;
  open(view: string, pinMs?: number): void;
  hide(): void;
  collapse(): void;
  reveal(): void;
  setView(view: string): void;
  note(text: string): void;
  error(err: unknown): void;
  pendingAlert(): boolean;
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
}

export interface IslandApi {
  readonly id: string;
  settings(): Settings;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null>;
  listen<T>(event: string, fn: (payload: T) => void): Disposer;
  timeout(fn: () => void, ms: number): Disposer;
  interval(fn: () => void, ms: number, opts?: { whenVisible?: boolean }): Disposer;
  status: { set(line: StatusLine | null): void };
  avatar: { publish(sig: AvatarSignal | null): void; emote(e: BotEmoteName): void; morph(v: number): void; gulp(): void };
  island: {
    open(view: string, opts?: { pinMs?: number }): void; setView(view: string): void; close(): void; wake(): void; hide(): void;
    keepAwake(pred: () => boolean): Disposer; isVisible(): boolean; mode(): IslandMode; fsmState(): FsmState; mouseInside(): boolean; view(): string;
    note(text: string): void; error(err: unknown): void; pendingAlert(): boolean; layoutHint(): void; redraw(): void; overlay(o: Overlay): Disposer;
  };
  provide<K extends keyof IslandHooks>(hook: K, fn: IslandHooks[K]): Disposer;
  call<K extends keyof IslandHooks>(hook: K, ...args: Parameters<IslandHooks[K]>): ReturnType<IslandHooks[K]> | undefined;
  onVisibility(fn: (mode: IslandMode, prev: IslandMode) => void): Disposer;
}

export interface ModuleInfo { id: string; label: string; defaultEnabled: boolean; requires?: string[] }
export interface ModuleDef extends ModuleInfo {
  views?: ViewDef[];
  tab?: TabDef;
  settings?: () => HTMLElement;
  start(api: IslandApi): Disposer | void;
}

export function resolveEnabled(catalog: readonly ModuleInfo[], stored: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of catalog) out[m.id] = (stored[m.id] ?? m.defaultEnabled) && (m.requires ?? []).every((r) => out[r] === true);
  return out;
}
