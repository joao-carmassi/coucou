// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift. Core only.

import { Tracked, Spring, clamp, mixColor } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import { wipe } from "../core/canvas";
import {
  COMPACT_BOT_CX, COMPACT_CONTENT_X, COMPACT_PAD, EXPANDED_CORNER, EXPANDED_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, botGlowColor, botGlowOpacity, botPosition, registerLayout, viewLayout,
  compactWidth, islandSize, miniGridSize,
} from "../core/layout";
import type { BotEmoteName, IslandMode, IslandViewName } from "../core/layout";
import { Avatar } from "../core/avatar";
import { Compact } from "../core/compact";
import { Hooks, emitMode } from "../core/hooks";
import type { Disposer, IslandHost, Overlay, TabDef, ViewContext, ViewDef } from "../core/moduleApi";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB, type RGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { buildHeader, buildViews, type Header, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine, type FsmState } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

/** How fast Mochi's body goes to a new colour, per second: about 90 % of the way in 0.4 s. */
const TINT_RATE = 5.5;
/** Closer than this on every channel (0…1), the body has its colour: a unit of 8-bit colour. */
const TINT_SETTLED = 0.004;

/** Minimum frame interval while compact with only the looping avatar animating. */
const IDLE_FRAME_MS = 60;

export class Island implements IslandHost {
  readonly fsm = new IslandStateMachine();
  readonly actions: ViewActions;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private activityEl!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: Header;
  private views!: Map<string, ViewHost>;
  /** Views modules registered, by name (tabOf, keyboard). */
  private viewDefs = new Map<string, ViewDef>();
  private overlays = new Set<Overlay>();
  private pinTimer: number | null = null;
  private kbFocus = false;

  private width = new Tracked(compactWidth(0, 0));
  private widthTarget = -1;
  private gridH = 0;
  private activityShown = false;
  private measureCtx = document.createElement("canvas").getContext("2d")!;
  private measured = { text: "", w: 0 };
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(COMPACT_BOT_CX);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();


  /** The colour Mochi body is drawn in, eased towards what it should be. */
  private bodyRGB: RGB | null = null;
  /** A body colour a view asked for (a chart's day under the mouse); wins over the pill's. His body only. */
  private tintRequest: RGB | null = null;

  private running = false;
  private lastFrame = 0;
  private lastOverlayBusy = false;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  // Press on Mochi: a plain click (no travel) is his slap.
  private botPress: { x: number; y: number } | null = null;
  private lastDown = false;
  private pressedOutside = false;

  // Compact island nudged sideways so what's under it can be clicked; glides home.
  private offsetX = new Spring(0, 0.45, 1);
  private nudge: { x: number; off: number; moved: boolean } | null = null;
  private nudgeTimer: number | null = null;

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "empty";

  private noteTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.actions = this.makeActions();
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      // Hidden draws nothing (h 0, bot opacity 0): keep the flag only; the next
      // mode change runs animateGeometry/ensureRunning and the frame does syncDom.
      if (State.mode !== "hidden") this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private makeActions(): ViewActions {
    return {
      setView: (v) => this.setView(v),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };
  }

  private build() {

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.activityEl = h("div", { id: "activity-line" });
    this.countdown = h("div", { id: "countdown" });


    this.header = buildHeader(this.actions, (v) => {
      const d = this.viewDefs.get(v);
      return d?.tabOf ?? (d?.lightsHome ? State.tabs.find((t) => t.home)?.view : undefined);
    });
    this.views = buildViews(this.actions);
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.greetingCanvas, this.contentEl);
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.activityEl,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";


    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.petitToHiddenDelay = State.settings.compactHideInterval;
    this.fsm.keepAwake = () => Hooks.some("keepAwake");
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home": {
          const r = Hooks.home();
          this.expand(r?.view ?? State.defaultView());
          if (r?.pin) State.isPinned = this.fsm.pinned = true;
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        }
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    this.tintRequest = null;
    // Any change of mode sends a nudged island home.
    this.nudge = null;
    this.clearNudgeTimer();
    this.offsetX.target = 0;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      this.clearPinTimer();
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") this.engine.resetMorph();
    emitMode(mode, prev);
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** A view with a DOM host, or the greeting (drawn on its own canvas). */
  private known(view: string): boolean {
    return view === "greeting" || this.views.has(view);
  }

  private guard(view: string): string {
    if (this.known(view)) return view;
    void Bridge.log(`ui  unknown view "${view}", using ${State.defaultView()}`);
    return State.defaultView();
  }

  expand(view: IslandViewName) {
    view = this.guard(view);
    if (view !== State.view) for (const o of this.overlays) o.leaving?.(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    view = this.guard(view);
    this.tintRequest = null;
    if (view !== State.view) for (const o of this.overlays) o.leaving?.(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = viewLayout(view).height >= viewLayout(State.view).height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    this.botPress = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Open on this view. Pinned alerts never auto-close; `pinMs` pins for that long. */
  open(view: IslandViewName, pinMs?: number) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
    if (!pinMs) return;
    this.clearPinTimer();
    this.fsm.pinned = true;
    this.pinTimer = window.setTimeout(() => {
      this.pinTimer = null;
      this.fsm.pinned = State.isPinned;
      if (this.fsm.state === "home" && !this.wasInIsland) this.fsm.mouseLeft();
      State.notify();
    }, pinMs);
  }

  private clearPinTimer() {
    if (this.pinTimer != null) window.clearTimeout(this.pinTimer);
    this.pinTimer = null;
  }

  hide() {
    this.fsm.forceHidden();
  }

  reveal() {
    this.fsm.reveal();
  }

  /** The mouse reaches a hidden island: it just peeks. */
  private mouseEnter() {
    const r = this.fsm.state === "hidden" ? Hooks.home() : null;
    if (r?.pin) {
      this.fsm.pinned = true;
      this.fsm.forceHome();
    } else this.fsm.mouseEntered();
  }

  /** A line on the note card for a moment, then back — unless the island moved on meanwhile. */
  showNote(message: string) {
    State.noteMessage = message;
    this.setView("note");
    if (this.noteTimer != null) window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.noteTimer = null;
      if (State.mode === "expanded" && State.view === "note") this.setView(State.defaultView());
    }, 2400);
  }

  /** Release of the left button: Mochi plain click, or the end of a nudge. Idempotent. */
  private onMouseUp() {
    if (this.botPress) {
      this.botPress = null;
      this.cancelBotHover();
      // A Mochi with news to tell takes you to it (a module's avatarClick); any other gets his slap.
      if (!Hooks.some("avatarClick")) this.engine.slap();
    } else if (this.nudge) {
      const moved = this.nudge.moved;
      this.nudge = null;
      if (moved) this.scheduleNudgeReturn();
      else this.fsm.click();
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    // A view that knows how tall its content is has the last word.
    const fitted = this.views?.get(State.view)?.height ?? null;
    const line = this.compactLine();
    const others = this.textOverGrid() ? 0 : State.otherPills.length;
    const cw = compactWidth(others, line ? this.textWidth(line) : 0);
    const { w, h } = islandSize(State.mode, State.view, fitted, cw);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  /** The one-line status the compact island says: the strongest module line. */
  private compactLine(): string {
    return Compact.resolve(State.otherPills.length)?.text ?? "";
  }

  /** The line takes the place of the mini grid (timer). */
  private textOverGrid(): boolean {
    return !!Compact.resolve(State.otherPills.length)?.overGrid;
  }

  /** New word rises from below while the old one leaves upward; instant if nothing was showing. */
  private setActivityText(line: string) {
    const cur = this.activityEl.lastElementChild as HTMLElement | null;
    if (cur?.textContent === line) return;
    const next = h("span", { text: line });
    this.activityEl.append(next);
    if (!cur || !this.activityShown) {
      this.activityEl.querySelectorAll("span").forEach((s) => s !== next && s.remove());
      return;
    }
    const opts = { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" as const };
    next.animate([{ transform: "translateY(100%)", opacity: 0 }, { transform: "none", opacity: 1 }], opts);
    cur.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], opts).onfinish = () =>
      cur.remove();
  }

  private textWidth(s: string): number {
    if (s === this.measured.text) return this.measured.w;
    const cs = getComputedStyle(this.activityEl);
    this.measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if ("letterSpacing" in this.measureCtx) this.measureCtx.letterSpacing = cs.letterSpacing;
    this.measured = { text: s, w: this.measureCtx.measureText(s).width };
    return this.measured.w;
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    this.widthTarget = w;
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    // Centred on a whole pixel of the screen. `translateX(-50%)` put the island
    // on a fraction of one for as long as its width was animating, and whatever
    // was painted then in a layer of its own — a scrolling list, say — kept
    // that fraction once the island had settled: its text stayed smeared until
    // it was drawn again.
    const dpr = window.devicePixelRatio || 1;
    const off = this.offset(w);
    this.islandEl.style.transform = `translateX(${Math.round((off - w / 2) * dpr) / dpr}px)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${COMPACT_CONTENT_X}px`;
    this.miniGrid.style.top = `${hh / 2 - this.gridH / 2}px`;
    this.activityEl.style.left = `${COMPACT_CONTENT_X}px`;
    this.activityEl.style.width = `${Math.max(0, w - COMPACT_CONTENT_X - COMPACT_PAD)}px`;
    // Growing reveals the text instead of flashing an ellipsis; it shows once settled.
    this.activityEl.style.textOverflow = this.width.animating ? "clip" : "";
    this.activityEl.style.top = `${hh / 2 - 8}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    for (const o of this.overlays) o.place?.(w);

    const rect = { x: (PANEL_W - w) / 2 + off, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2 + this.offset(w), y: 0, w, h: hh };
  }

  /** Sideways nudge, kept inside the window whatever the island's width. */
  private offset(w: number): number {
    const m = Math.max(0, (PANEL_W - w) / 2);
    return clamp(this.offsetX.value, -m, m);
  }

  private clearNudgeTimer() {
    if (this.nudgeTimer != null) window.clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
  }

  /** A nudged island glides back 10 s after the release, never from under the cursor. */
  private scheduleNudgeReturn() {
    this.clearNudgeTimer();
    this.nudgeTimer = window.setTimeout(() => {
      this.nudgeTimer = null;
      if (this.wasInIsland || this.nudge) return this.scheduleNudgeReturn();
      this.offsetX.target = 0;
      this.ensureRunning();
    }, 10_000);
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.mouseEnter();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        // Compact opens on the release: a press that travels is a sideways nudge.
        if (State.mode === "compact") this.nudge = { x: e.clientX, off: this.offset(this.width.value), moved: false };
        else this.fsm.click();
        return;
      }
      // The slap (or news) waits for the release: past 7 px this is a drag-out.
      if (this.isBotHit(e.clientX, e.clientY)) this.botPress = { x: e.clientX, y: e.clientY };
    });

    // The DOM only sees releases over our window; the cursor poll's falling edge
    // covers the rest. Both funnel into onMouseUp.
    window.addEventListener("mouseup", () => {
      this.onMouseUp();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });


    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates; `down` is the left button, from Rust's poll. */
  onCursor(x: number, y: number, down = false) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };
    let held = false;
    for (const o of this.overlays) held = o.cursor?.(State.mouseInIsland.x, State.mouseInIsland.y, down) === true || held;

    const released = this.lastDown && !down;
    const pressed = down && !this.lastDown;
    this.lastDown = down;
    if (this.nudge && down && (this.nudge.moved || Math.abs(x - this.nudge.x) > 5)) {
      this.nudge.moved = true;
      const m = Math.max(0, (PANEL_W - this.width.value) / 2);
      this.offsetX.set(clamp(this.nudge.off + x - this.nudge.x, -m, m)); // x only, never y
      this.ensureRunning();
    }
    // Pulled away from Mochi: not a click any more.
    if (this.botPress && down && Math.hypot(x - this.botPress.x, y - this.botPress.y) > 7) {
      this.botPress = null;
      this.cancelBotHover();
      Hooks.all("avatarPull"); // pulled out of the island: a module may carry him on
    }
    if (held) { this.ensureRunning(); return; } // a module drag owns the pointer: no hover or auto-close bookkeeping

    // A click elsewhere on screen folds the island (#31). Judged on the release, so a file
    // dragged in from Explorer and dropped on us isn't one; a pinned island (isPinned) keeps it.
    const inRect = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    if (pressed) this.pressedOutside = !inRect;
    if (released && this.pressedOutside) {
      this.pressedOutside = false;
      if (!inRect && State.mode === "expanded" && !State.isPinned) this.collapse();
    }
    // A stale press (released off the island) must not turn a later drag into a ghost.
    if (released && (this.botPress || this.nudge)) this.onMouseUp();


    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.mouseEnter();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      // The loop is stopped while idle: without this the emote only shows once the mouse moves.
      this.ensureRunning();
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.open("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(this.effState());
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
      this.ensureRunning();
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    // Compact, cursor away, only the looping avatar idle (breathe/scan/sweat/zz): ~15 fps.
    // Every presented frame costs the GPU process ~4 ms of CPU (a 720x320 transparent window), so
    // the rate is the cost. The skipped frame is a timer, not a rAF poll: polling woke the main
    // thread on every vsync (240 Hz). dt keeps accumulating (capped below) so motion speed is unchanged.
    if (State.mode === "compact" && !this.wasInIsland && !this.dirty && !this.lastOverlayBusy &&
        !this.width.animating && !this.height.animating && !this.radius.animating && this.offsetX.settled &&
        this.botCx.settled && this.botCy.settled && this.botSize.settled && !this.tintSettling &&
        !this.engine.animating && nowMs - this.lastFrame < IDLE_FRAME_MS) {
      window.setTimeout(() => requestAnimationFrame(this.frame), IDLE_FRAME_MS - (nowMs - this.lastFrame) - 8);
      return;
    }
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.offsetX.step(dt);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    tickMiniBots(dt);
    this.shimmer(nowMs);
    this.views.get(State.view)?.tick?.(nowMs);
    let overlayBusy = false;
    for (const o of this.overlays) {
      const on = o.active();
      o.el.style.display = on ? "" : "none";
      if (on && o.frame(nowMs)) overlayBusy = true; // every overlay draws, no short-circuit
    }
    this.lastOverlayBusy = overlayBusy;
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either (engine.busy is permanently true for looping animations).
    // Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating || !this.offsetX.settled;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || this.tintSettling || overlayBusy ||
        (State.mode === "compact" && this.activityShown) ||
        // The auto-close countdown bar is only redrawn here; a stopped loop froze
        // it and it caught up in jumps whenever something else animated.
        (State.mode === "expanded" && !State.isPinned && this.homeCollapseAt != null);

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  /** Text shimmer of the compact status line, stepped here so each repaint lands in the frame the avatar
   *  is drawn in: a CSS animation of its own presented a second frame to the GPU process, at the same
   *  rate, out of phase (60 presents/s instead of 30, ~4 ms of GPU-process CPU each). */
  private shimmer(nowMs: number) {
    if (State.mode !== "compact" || !this.activityShown) return;
    const span = this.activityEl.lastElementChild as HTMLElement | null;
    if (!span) return;
    const pos = `${100 - Math.floor((nowMs % 2000) / 33.34) * (100 / 60)}% center, 0 0`;
    if (span.style.backgroundPosition !== pos) span.style.backgroundPosition = pos;
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    this.botCanvas.style.opacity = p.opacity > 0 && !greetingActive ? "1" : "0";

    if (State.mode === "expanded" && !greetingActive && viewLayout(State.view).glow !== false) {
      const d = p.diameter;
      const color = botGlowColor(this.effState());
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(this.effState()));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    this.engine.bodyColor = this.easeBodyColor(dt);
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    this.engine.slotHTarget = 0;
    this.engine.slotH = 0;
    this.engine.slotHVel = 0;
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wipe(ctx);
    this.engine.draw(ctx, w, hCss);
  }

  /** What the avatar wears: override > strongest module signal > focused task > idle. */
  private effState() {
    return Avatar.state(State.focusPill?.mood ?? State.avatarState ?? "idle", State.stateOverride);
  }

  /** The colour Mochi should be: his focused pill colour, else his own cream. */
  private targetBodyColor(): RGB | null {
    if (this.tintRequest) return this.tintRequest;
    const focus = State.focusPill;
    return focus ? hexToRGB(focus.color) : null;
  }

  /**
   * Eases the body towards its target rather than jumping, so sliding the mouse
   * across the graph reads as Mochi slowly changing colour, not flickering:
   * about 90 % of the way in 0.4 s, blended in OKLab so red to green stays
   * bright instead of dipping through brown. Null — his own cream gradient —
   * can't be blended into, and is simply taken.
   */
  private easeBodyColor(dt: number): RGB | null {
    const target = this.targetBodyColor();
    if (!target || !this.bodyRGB) {
      this.bodyRGB = target;
      return target;
    }
    this.bodyRGB = mixColor(this.bodyRGB, target, 1 - Math.exp(-dt * TINT_RATE));
    return this.bodyRGB;
  }

  /** True while the body colour is still on its way — the frame loop keeps going. */
  private get tintSettling(): boolean {
    const target = this.targetBodyColor();
    if (!target || !this.bodyRGB) return false;
    return this.bodyRGB.some((v, i) => Math.abs(v - target[i]) > TINT_SETTLED);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────
  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    // Folded or hidden, the views are out of sight but still in the page: what
    // moves in them on its own stops (see #content.away).
    this.contentEl.classList.toggle("away", !expanded);
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    const kb = expanded && !!this.viewDefs.get(State.view)?.keyboard;
    if (kb !== this.kbFocus) {
      this.kbFocus = kb;
      void Bridge.focusWindow(kb);
      if (kb) this.views.get(State.view)?.focus?.();
    }

    const emote = Avatar.takeEmote();
    if (emote) this.engine.triggerEmote(emote);

    // Compact mini grid
    const showGrid = State.mode === "compact" && !this.textOverGrid();
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherPills.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        const g = miniGridSize(others.length);
        this.miniGrid.style.width = `${g.w}px`;
        this.miniGrid.style.height = `${g.h}px`;
        this.gridH = g.h;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    const line = State.mode === "compact" ? this.compactLine() : "";
    this.activityEl.style.opacity = line ? "1" : "0";
    this.activityEl.classList.toggle("on", !!line);
    if (line) this.setActivityText(line);
    this.activityShown = !!line;

    // Text or minis changed while compact: the island follows, width only
    // (height/radius belong to a running hidden→compact spring). Not while hidden:
    // the window is collapsed and the frame loop must stay idle.
    if (State.mode === "compact") {
      const w = this.targetSize().w;
      if (w !== this.widthTarget) {
        this.widthTarget = w;
        if (w < this.width.value) this.width.curveTowards(w);
        else this.width.springTo(w);
        this.ensureRunning();
      }
    }

    syncMiniBotStates(State.pills);
    this.engine.setState(this.effState());
  }

  // ── IslandHost (what the registry gets) ─────────────────────────────────────

  note(text: string) {
    this.showNote(text);
  }

  error(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    void Bridge.log(`ui  error ${msg}`);
    this.showNote(msg);
  }

  pendingAlert(): boolean {
    return State.mode === "expanded" && State.isPinned;
  }

  /** From the live cursor: wasInIsland is frozen while a module drag holds the pointer (onCursor returns early). */
  mouseInside(): boolean {
    const r = this.islandRect();
    const { x, y } = State.mouse;
    return x >= r.x - HIT_MARGIN && x <= r.x + r.w + HIT_MARGIN && y >= r.y - HIT_MARGIN && y <= r.y + r.h + HIT_MARGIN;
  }

  fsmState(): FsmState {
    return this.fsm.state;
  }

  layoutHint() {
    this.animateGeometry(false);
  }

  redraw() {
    this.dirty = true;
    if (State.mode !== "hidden") this.ensureRunning(); // hidden: lazy, see the subscribe above
  }

  addView(def: ViewDef, ctx: ViewContext): Disposer {
    const host = def.build(ctx);
    const offLayout = registerLayout(def.name, def.layout);
    this.views.set(def.name, host);
    this.viewDefs.set(def.name, def);
    this.viewsEl.append(host.el);
    return () => {
      offLayout();
      host.el.remove();
      this.views.delete(def.name);
      this.viewDefs.delete(def.name);
      State.tabs = State.tabs.filter((t) => t.view !== def.name); // setTabs comes after the stop
      if (State.view === def.name) {
        if (State.mode === "expanded") this.setView(State.defaultView());
        else State.view = State.defaultView();
      }
      State.notify();
    };
  }

  setTabs(tabs: TabDef[]) {
    State.tabs = tabs;
    this.header.setTabs(tabs);
    // The empty card was home: a module came on, so move to the new home.
    if (State.view === "empty" && State.defaultView() !== "empty") {
      if (State.mode === "expanded") this.setView(State.defaultView());
      else State.view = State.defaultView();
    }
    this.redraw();
  }

  addOverlay(o: Overlay): Disposer {
    this.overlays.add(o);
    this.islandEl.append(o.el);
    o.place?.(this.width.value);
    this.redraw();
    return () => {
      this.overlays.delete(o);
      o.el.remove();
    };
  }

  avatarEmote(e: BotEmoteName) {
    this.engine.triggerEmote(e);
    this.ensureRunning();
  }

  avatarMorph(v: number) {
    this.engine.animateMorph(v);
    this.ensureRunning();
  }

  avatarTint(color: string | null) {
    this.tintRequest = color ? hexToRGB(color) : null;
    this.ensureRunning();
  }

  /** Body color the island Mochi is currently drawn with (#rrggbb), or null for the default. */
  avatarBodyColor(): string | null {
    const c = this.engine.bodyColor;
    return c ? "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("") : null;
  }

  avatarGulp() {
    this.engine.gulp();
    this.ensureRunning();
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.petitToHiddenDelay = State.settings.compactHideInterval;
    // Re-arm with the new delay (or cancel it, for "never") if already minimized.
    if (this.fsm.state === "petit" && !this.wasInIsland) this.fsm.mouseLeft();
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }
}
