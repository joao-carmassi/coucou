# Module contract (M4)

Authoritative spec for the module system. Written by the Opus advisor against `m3-ok`; adapted
to the **core-only** tree (tag `m3b-core-only`): there is no legacy code to adapt, modules are
ported one by one in M5 from `git show m3-ok:<path>`.

Decisions: modules ON by default: `claude`, `media`, `upload`. OFF: `timer`, `voice`, and the
seven service modules (`github`, `vercel`, `stripe`, `n8n`, `resend`, `calcom`, `notion`). `voice` and `upload` require `claude`. A disabled module has no tab, view,
pill, timer, thread, or listener. One status line: highest priority wins. Commands are NOT
gated in M4 (a command only answers a request); `host.require(id)` exists for M5.
Settings stay one FLAT `settings.json`; unknown keys travel in `extra`.

Rule for `compact.ts`, `avatar.ts`, `moduleApi.ts`, `modules/catalog.ts`: only `import type {...}`
(never `import { type X }`), so Node can load them in tests.

## Rust (M4a)

`core/host.rs` (new). Module trait, ModuleCtx, TaskSet, ModuleHost:

```rust
pub struct ModuleInfo { pub id: &'static str, pub label: &'static str, pub default_enabled: bool, pub requires: &'static [&'static str], pub group: Option<&'static str> }

pub trait Module: Send + Sync {
    fn id(&self) -> &'static str;
    /// Never called while the module is off. Must not call the host (its lock is held).
    fn start(&self, ctx: &ModuleCtx, s: &Settings);
    fn stop(&self, _ctx: &ModuleCtx) {}               // unblock what the host cannot end by itself
    fn apply(&self, _ctx: &ModuleCtx, _s: &Settings) {} // settings saved while running
}
enum Task { Thread(std::thread::JoinHandle<()>), Async(tauri::async_runtime::JoinHandle<()>) }
pub struct TaskSet(Mutex<Vec<Task>>);   // end(id): abort async; join threads within GRACE=250ms, log stuck ones
pub struct ModuleCtx { pub id, pub app: AppHandle, pub stop: Arc<AtomicBool>, pub tasks: TaskSet, listeners: Mutex<Vec<EventId>> }
impl ModuleCtx {
    pub fn stopping(&self) -> bool;
    pub fn spawn<F: FnOnce(Arc<AtomicBool>) + Send + 'static>(&self, f: F); // the ONLY way a module makes a thread
    pub fn spawn_async<F: Future<Output=()> + Send + 'static>(&self, f: F);
    pub fn adopt(&self, h: tauri::async_runtime::JoinHandle<()>);
    pub fn listen<F: Fn(tauri::Event) + Send + 'static>(&self, event: &str, f: F);
}
pub struct ModuleHost { catalog, modules: Vec<Box<dyn Module>>, running: Mutex<HashMap<&'static str, Arc<ModuleCtx>>>, effective: Mutex<BTreeMap<String,bool>> }
impl ModuleHost {
    pub fn new(catalog: &'static [ModuleInfo], modules: Vec<Box<dyn Module>>) -> Self;
    /// stored ?? default, and every requirement on.
    pub fn resolve(&self, s: &Settings) -> BTreeMap<String,bool>;
    /// Boot and every save: stop what went off (reverse order), start what came on, call apply on running, emit `modules-changed` if the map moved.
    pub fn sync(&self, app: &AppHandle, s: &Settings);
    pub fn set_enabled(&self, app: &AppHandle, id: &str, on: bool, s: &Settings); // logs "[module] start|stop <id>"; stop: set ctx.stop, m.stop(), unlisten all, tasks.end
    pub fn is_enabled(&self, id: &str) -> bool;
    pub fn require(&self, id: &str) -> Result<(), String>; // "O módulo {label} está desligado nas Configurações."
    pub fn state(&self) -> BTreeMap<String,bool>;
}
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String>;
```

Unit test: `requires_follow_claude` (claude off => voice and upload off).

`modules/mod.rs`:

```rust
pub const CATALOG: &[ModuleInfo] = &[
  ModuleInfo { id: "claude", label: "Claude Code", default_enabled: true,  requires: &[], group: Some("Claude") },
  ModuleInfo { id: "media", label: "Mídia", default_enabled: true, requires: &[], group: None },
  ModuleInfo { id: "timer", label: "Timer", default_enabled: false, requires: &[], group: None },
  ModuleInfo { id: "upload", label: "Soltar arquivo", default_enabled: true, requires: &["claude"], group: Some("Claude") },
  ModuleInfo { id: "voice", label: "Voz", default_enabled: false, requires: &["claude"], group: Some("Claude") },
  ModuleInfo { id: "github", label: "GitHub", default_enabled: false, requires: &[], group: Some("Integrações") },
  ModuleInfo { id: "vercel", label: "Vercel", default_enabled: false, requires: &[], group: Some("Integrações") },
  ModuleInfo { id: "stripe", label: "Stripe", default_enabled: false, requires: &[], group: Some("Integrações") },
  ModuleInfo { id: "n8n", label: "n8n", default_enabled: false, requires: &[], group: Some("Integrações") },
  ModuleInfo { id: "resend", label: "Resend", default_enabled: false, requires: &[], group: Some("Integrações") },
  ModuleInfo { id: "calcom", label: "Cal.com", default_enabled: false, requires: &[], group: Some("Integrações") },
  ModuleInfo { id: "notion", label: "Notion", default_enabled: false, requires: &[], group: Some("Integrações") },
];
pub fn registry() -> Vec<Box<dyn Module>> { vec![] } // M5 adds one entry per ported module
```
(`timer` and `upload` may exist only in TS: catalog entry, no `impl Module`.)

`core/hotkeys.rs` (new): the `GetMessageW` loop, shared; module registers its own combo.
(Written in M4a as an empty-but-working API; first user is the voice/claude port in M5.)
```rust
pub type Handler = fn(&AppHandle);
pub fn set(app: &AppHandle, name: &'static str, label: &'static str, combo: &str, on: Handler); // "" clears; thread rebuilt only on change
pub fn clear(app: &AppHandle, name: &'static str);
pub fn error() -> String;
pub fn clean(s: &str, default: &str) -> String;
```
Source of the loop to adapt: `git show m3-ok:windows/src-tauri/src/modules/voice/voice.rs` (parse_hotkey, hotkey_loop, quit_thread, THREAD, HANDLE). Error event keeps the name `voice-hotkey-error`.

`core/settings.rs`:
- struct uses `#[serde(default, rename_all = "camelCase")]`; keep `extra` flatten.
- add `#[serde(default)] pub modules_enabled: BTreeMap<String,bool>` (before `extra`), and
  `pub fn module_on(&self, id:&str, default:bool)->bool`.
- `load()`: when parsing fails, copy the file to `settings.json.corrupt-<unix_secs>` (std::fs::copy, never overwrite the original), return defaults.
- migration (voice was `voiceEnabled`, integrations were `activeIntegrations`): since the module fields live in `extra` now, read them from `extra`:
```rust
/// Fills the switches a pre-module settings.json lacks; keys present are the user's. True when something was added.
pub fn migrate_modules(s: &mut Settings) -> bool; // claude/media/upload => true; timer => false; voice => extra["voiceEnabled"] truthy; one module per service (github, vercel, stripe, n8n, resend, calcom, notion) => true when extra["activeIntegrations"] contains `integration_<short>`, else false
```
Tests: keep `removed_keys_round_trip`; add `migrate_installed_baseline` (same sample JSON; expected map `{claude,media,upload:true; timer,voice,github,vercel,stripe,n8n,resend,calcom,notion:false}`; every original key still equal after serialize), `migrate_keeps_user_choice` (`{"timer":true,"claude":false}` stays), `migrate_from_legacy` (`voiceEnabled:true` -> voice on).

`lib.rs`: `.manage(ModuleHost::new(modules::CATALOG, modules::registry()))`; in `run()`: `let mut loaded = settings::load(); if settings::migrate_modules(&mut loaded) { let _ = settings::save(&loaded); }`; in setup after log line: `handle.state::<ModuleHost>().sync(&handle, &loaded);`. `BootInfo` gains `modules: BTreeMap<String,bool>` (= host.state()). `save_settings`: inside the lock `if settings.modules_enabled.is_empty() { settings.modules_enabled = current.modules_enabled.clone(); }`; AFTER releasing the lock call `app.state::<ModuleHost>().sync(&app, &settings)` (never under the Shared lock: deadlock risk). Commands stay the 12 core ones.

## TypeScript (M4b)

`core/moduleApi.ts` (types only + `resolveEnabled`):

```ts
import type { BotEmoteName, BotStateName, IslandMode, ViewLayout } from "./layout";
import type { Settings } from "./state";
import type { FsmState } from "../island/fsm";
import type { ViewActions } from "../views/views";
export type Disposer = () => void;
/** Higher wins, tie goes to the most recent. approval 100, question 90, error 80, finished 60, timer 50, voice 40, Claude activity 30, media 20, integrations 10. */
export interface StatusLine { priority: number; text: string; icon?: string; ttlMs?: number; urgent?: boolean;
  /** Shown beside other pills in place of the mini grid (the timer). Default: only when no other pill. */ overGrid?: boolean }
export interface AvatarSignal { state: BotStateName; priority: number; emote?: BotEmoteName; ttlMs?: number }
export interface ViewHost { el: HTMLElement; sync(): void; focus?(): void; tick?(nowMs: number): void; readonly height?: number }
export interface ViewContext { actions: ViewActions; onResize(): void; api: IslandApi }
export interface ViewDef { name: string; layout: ViewLayout; tabOf?: string; lightsHome?: true; keyboard?: boolean; build(ctx: ViewContext): ViewHost }
export interface TabDef { view: string; title: string; icon(): Element; order: number; home?: true }
export interface Overlay { el: HTMLElement; active(): boolean; frame(nowMs: number): boolean; cursor?(x:number,y:number):void; place?(islandW:number):void; leaving?(nextView:string):void }
export interface HomeRequest { view: string; pin: boolean; priority: number }
export interface IslandHooks { homeView(): HomeRequest | null; keepAwake(): boolean; pillOpen(taskId: string): boolean; avatarClick(): boolean; avatarPull(): void }
export interface IslandHost { // what Island lends the registry
  readonly actions: ViewActions; open(view: string, pinMs?: number): void; hide(): void; collapse(): void; reveal(): void;
  setView(view: string): void; note(text: string): void; error(err: unknown): void; pendingAlert(): boolean; mouseInside(): boolean;
  fsmState(): FsmState; layoutHint(): void; redraw(): void;
  addView(def: ViewDef, ctx: ViewContext): Disposer; setTabs(tabs: TabDef[]): void; addOverlay(o: Overlay): Disposer;
  avatarEmote(e: BotEmoteName): void; avatarMorph(v: number): void; avatarGulp(): void }
export interface IslandApi {
  readonly id: string; settings(): Settings;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null>;
  listen<T>(event: string, fn: (payload: T) => void): Disposer;
  timeout(fn: () => void, ms: number): Disposer;
  interval(fn: () => void, ms: number, opts?: { whenVisible?: boolean }): Disposer;
  status: { set(line: StatusLine | null): void };
  avatar: { publish(sig: AvatarSignal | null): void; emote(e: BotEmoteName): void; morph(v: number): void; gulp(): void };
  island: { open(view: string, opts?: { pinMs?: number }): void; setView(view: string): void; close(): void; wake(): void; hide(): void;
    keepAwake(pred: () => boolean): Disposer; isVisible(): boolean; mode(): IslandMode; fsmState(): FsmState; mouseInside(): boolean; view(): string;
    note(text: string): void; error(err: unknown): void; pendingAlert(): boolean; layoutHint(): void; redraw(): void; overlay(o: Overlay): Disposer };
  provide<K extends keyof IslandHooks>(hook: K, fn: IslandHooks[K]): Disposer;
  provide<T>(service: `${string}.${string}`, impl: T): Disposer; // services: namespaced key, removed when the module stops
  use<T>(service: `${string}.${string}`): T | undefined;          // first provider; undefined = feature absent
  useAll<T>(service: `${string}.${string}`): T[];
  call<K extends keyof IslandHooks>(hook: K, ...args: Parameters<IslandHooks[K]>): ReturnType<IslandHooks[K]> | undefined;
  onVisibility(fn: (mode: IslandMode, prev: IslandMode) => void): Disposer;
}
export interface ModuleInfo { id: string; label: string; defaultEnabled: boolean; requires?: string[] }
export interface ModuleDef extends ModuleInfo { views?: ViewDef[]; tabs?: TabDef[]; settings?: () => HTMLElement; start(api: IslandApi): Disposer | void }
export function resolveEnabled(catalog: readonly ModuleInfo[], stored: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of catalog) out[m.id] = (stored[m.id] ?? m.defaultEnabled) && (m.requires ?? []).every((r) => out[r] === true);
  return out;
}
```
(There is no `legacy` field: the core-only tree has no legacy handlers.)

`core/hooks.ts` (the island imports THIS, never modules): `Hooks.provide/all/first/has/some/home`, `onMode(fn)`, `emitMode(mode, prev)`.
`Hooks.home()` = highest `priority` among `homeView()` results.

`core/compact.ts`: `Compact.set(owner, line|null): boolean` (true when it changed; never notifies State) and `Compact.resolve(otherPills: number, now?)`: highest priority, tie = most recent, ttl checked at draw time, a line without `overGrid` is skipped when `otherPills > 0`.

`core/avatar.ts`: `Avatar.publish(owner, sig|null): boolean`, `Avatar.state(fallback, override, now?)` (override > strongest signal (tie = most recent, ttl at draw) > fallback), `Avatar.takeEmote()`.

`core/registry.ts` (the ONLY core file that imports `../modules`): `Scope` (add/dispose in reverse, errors logged), `Registry.init(host: IslandHost)`, `Registry.defaults(stored)`, `Registry.isOn(id)`, `Registry.apply(map)`: stop what went off (reverse catalog order), start what came on (views registered, `def.start(api)`, log `[module] start <id>`), `host.setTabs(...)` from running modules sorted by `tab.order`. `makeApi(id, scope, host)`: every disposable is added to the Scope; `interval` with `whenVisible` is disarmed when `State.mode === "hidden"` (via `onMode`) and re-armed after; `status.set` and `avatar.publish` call `host.redraw()` only when the resolver reports a change (NEVER `State.notify`); `stop(def)` also clears `Compact` and `Avatar` for that owner.
`modules/catalog.ts`: `MODULE_INFO` with the same ids/order/defaults/requires as the Rust `CATALOG`. `modules/index.ts`: `export const MODULES: ModuleDef[] = []` (M5 adds entries).

`core/layout.ts`: `CoreViewName` typed union (core views only), `IslandViewName = string`, `VIEW_LAYOUTS: Record<string, ViewLayout>`, `viewLayout(v)` (fallback to `overview`/`empty`), `registerLayout(v, layout): Disposer`; `ViewLayout` gains optional `newsLine`, `proposalRoom`, `botTrack: {from,span}`, `glow?: false`, and `islandSize/botPosition` read those instead of comparing view names.
`core/state.ts`: `modules: Record<string,boolean>`, `Settings.modulesEnabled: Record<string,boolean>` (default `{}`). `core/bridge.ts`: `BootInfo.modules`.

`island/island.ts` (the island becomes the host; hook points, NO module imports):
- `Island implements IslandHost`; `actions` becomes a field; `open(view, pinMs)` = `forceHome` + `expand(view)` + optional timed pin (the old `mediaPinTimer` pattern from `git show m3-ok:windows/src/island/island.ts`).
- Home transition: `const r = Hooks.home(); this.expand(r?.view ?? State.defaultView()); if (r?.pin) State.isPinned = this.fsm.pinned = true;`
- `fsm.keepAwake = () => Hooks.some("keepAwake")`; `compactLine()` = `Compact.resolve(State.otherTasks.length)?.text ?? ""`; `textOverGrid()` = `!!Compact.resolve(...)?.overGrid`.
- avatar state = `Avatar.state(State.focusTask?.state ?? State.avatarState ?? "idle", State.stateOverride)`; in `syncDom`: `const e = Avatar.takeEmote(); if (e) this.engine.triggerEmote(e);`.
- `setMode`: call `emitMode(mode, prev)` at the exact place where modules used to hook (before `updateWindowCollapsed`/`animateGeometry`).
- Frame loop: `busy` also includes `overlays.some(o => o.frame(now))`; draws overlays; `onCursor` forwards to `overlay.cursor`.
- `setView`/`expand`: guard for an unregistered view (log, fall back to `State.defaultView()`); `addView` removes the view and returns to default if it is on screen.
- Header (`buildHeader` in views.ts): gear + sound + the tabs from `setTabs(TabDef[])`; no built-in Home. A tab is lit when `State.view === tab.view` or the view declares `tabOf: <tab.view>` or `lightsHome` (lights the tab flagged `home`).
- Home (`homeOf` in core/hooks.ts, `State.defaultView()`): strongest `homeView` request, else the tab flagged `home`, else the first tab by `order`, else the core `empty` view (also the only layout fallback).
- `main.ts`: `Registry.init(island); Registry.apply(boot?.modules ?? Registry.defaults(State.settings.modulesEnabled)); await onEvent("modules-changed", Registry.apply);`
- Settings window (`settings/main.ts`): a "Módulos" section with one toggle per `MODULE_INFO`; a dependent is disabled and labelled "Requer <label>" while its requirement is off; writes `modulesEnabled`; re-renders on `modules-changed`.

Tests: `windows/tests/resolvers.test.ts` (node --test, strip-types): Compact (30 alone is shown; 50 `overGrid` beats 30; 100 beats 50; with `others=2` only `overGrid` lines show; none -> null; tie -> most recent; expired ttl ignored), Avatar (override > signal > fallback), `resolveEnabled({})` gives the defaults and `{claude:false, voice:true}` leaves voice and upload false.

## Gate C checks (from `windows/`)

```
npx tsc --noEmit && npm run build && node --test tests/resolvers.test.ts
cd src-tauri && cargo check && cargo test
grep -rn "from \"\.\./modules" src/island                       # empty
grep -rnE "\.\./modules" src/core | grep -v registry.ts        # empty
diff <(grep -o 'id: "[a-z]*"' src-tauri/src/modules/mod.rs) <(grep -o 'id: "[a-z]*"' src/modules/catalog.ts)
```
Runtime: with an empty `MODULES` the app behaves as the core-only build; the Settings window lists six toggles; flipping them writes `modulesEnabled` and the log prints nothing for modules that have no implementation yet.

## Risks (island.ts)
1. `emitMode` must sit exactly where the old module hooks were in `setMode`.
2. `VIEW_LAYOUTS[view]` must never be indexed with an unregistered view: use `viewLayout()`.
3. `status.set`/`avatar.publish` never call `State.notify` (no loop).
4. The frame loop's `busy` includes overlay frames, or overlays freeze.
5. Pass island methods as arrow functions (lost `this`).
6. `host.sync` runs on the main thread: never under the `Shared` lock.

## Status (branch refactor/modules)

All modules are ported (M5). The pre-refactor code is in git tag `m3-ok` (`git show m3-ok:<path>`).
Nothing below is verified at runtime beyond the checks in `docs/idle-baseline.md`.

| Module | Default | Notes |
|---|---|---|
| claude | ON | Backend `src-tauri/src/modules/claude`, frontend `src/modules/claude`. Integration news on its finished/error cards comes through the `taskNews` hook |
| media | ON | Mochi drag-out ghost lives in the module (core hooks: `mochiDrop`, `Overlay.cursor(down)`). `attach_window` and claude's `ingest_file` share `core/inbox.rs` |
| upload | ON, requires claude | The drop animation starts after the island opens |
| timer | OFF | Countdown and stopwatch |
| voice | OFF, requires claude | English only (Cactus `needle.exe` + Whistle model). The "go to alert" hotkey belongs to claude |
| github, vercel, stripe, n8n, resend, calcom, notion | OFF | One module per service (group "Integrações"). One shared scheduler, no task while none is on. Hooks used: `taskCard`, `taskNews`, `avatar.tint` |

Known limit: the compact grid shows at most 4 mini pills (display limit, not a limit on modules).

## Neutrality baseline

`npm run neutrality-audit` (warn mode; `-- --fail` exits 1; `-- --verbose` lists lines). Findings = hits in code, warnings = comment-only hits. Baseline at M0 (before M1/M2): **172 findings, 99 warnings**.

```
file                                    findings  warnings
src-tauri/src/core/drop_target.rs              3         1
src-tauri/src/core/hotkeys.rs                  6         0
src-tauri/src/core/inbox.rs                    3         4
src-tauri/src/core/island.rs                   0         2
src-tauri/src/core/platform/mod.rs             0         2
src-tauri/src/core/platform/windows.rs         0         2
src-tauri/src/core/settings.rs                 8         0
src-tauri/src/lib.rs                         135         4
src/core/anim.ts                               0         2
src/core/badge.ts                              1         0
src/core/bridge.ts                             0        43
src/core/hooks.ts                              0         1
src/core/layout.ts                             3         0
src/core/moduleApi.ts                          0         6
src/core/registry.ts                           0         1
src/core/sound.ts                              1         0
src/island/fsm.ts                              0         1
src/island/island.ts                           0         6
src/mochi/engine.ts                            4         0
src/settings/main.ts                           3         1
src/views/code.ts                              0        12
src/views/icons.ts                             1         7
src/views/palette.ts                           0         4
src/views/views.ts                             4         0
TOTAL findings 172, warnings 99, allowlisted 4
```

After M1 (bridge split) the comment-only warnings dropped 99 -> 56 (findings unchanged: the typed calls only moved, `src/core/bridge.ts` is now clean). After M2 (CSS) and the audit allowlist update: see the latest `npm run neutrality-audit` output.

## Module CSS (M2)

- `src/style/index.ts` imports only the shared sheets (ui, core, overview, settings). Every module imports its own sheets from its `index.ts` (claude: base, chat, panel, claude; upload; integrations (in `provider.ts`); media; timer).
- `src/main.ts` imports `./style` before anything that reaches `modules/index`, so module sheets land AFTER the shared ones (needed for ties such as `.sess-newbtn` vs `.btn`).
- Inter-module order = the import order in `modules/index.ts` (claude, upload, integrations, media, timer, voice), NOT the catalog order. Sheets that were interleaved before (upload between claude chat and panel; integrations between claude panel and claude.css) now follow all claude sheets; checked: no tie between rules that can hit the same element.
- The settings window must never import a module `index.ts` (it would pull the island CSS: `html,body{overflow:hidden}`). It loads `src/modules/settings.ts` (`SETTINGS_SECTIONS`, keyed by module id); each module's `settings.css` is imported from its `settings.ts`. `ModuleDef.settings` was removed.

## Hooks and services (M3/M4)

Core hooks (generic, the island calls them): `homeView`, `keepAwake`, `pillOpen(taskId)` (a pill's arrow), `avatarClick()` (Mochi clicked; true = a module took it, no slap), `avatarPull()` (Mochi pulled out of the island).

Services are module-to-module and invisible to the core: `api.provide("<module>.<name>", impl)`, `api.use<T>(key)` (first provider) and `api.useAll<T>(key)`. Keys and types live ONLY in the owning module's `api.ts` (types only; consumers `import type`). They are dropped when the provider stops; a consumer treats `undefined` as "feature absent".

| Key | Provider | Consumer | Type |
|---|---|---|---|
| `claude.launchFile` | claude | media ("Abrir no Claude" entry), upload | `(path, ingest) => Promise<void>` |
| `claude.taskCard` | each integration, for its own pill | claude overview (first non-null) | `(taskId) => TaskCard \| null` |
| `claude.taskNews` | each integration, for its own pill | claude finished/error cards | `(taskId) => TaskNews \| null` |

`taskCard`/`taskNews` use the claude namespace because claude owns the slot; the providers are the many integrations, so lookups are lazy and survive claude restarts. Without claude, nobody asks and integrations show no card.
