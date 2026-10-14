# Module contract (M4)

Authoritative spec for the module system. Written by the Opus advisor against `m3-ok`; adapted
to the **core-only** tree (tag `m3b-core-only`): there is no legacy code to adapt, modules are
ported one by one in M5 from `git show m3-ok:<path>`.

Decisions: modules ON by default: `board`, `claude`, `media`, `upload`. OFF: `timer`, `voice`, and the
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

`lib.rs`: `.manage(ModuleHost::new(modules::CATALOG, modules::registry()))`; in `run()`: `let mut loaded = settings::load(); if settings::migrate_modules(&mut loaded) { let _ = settings::save(&loaded); }`; in setup after log line: `handle.state::<ModuleHost>().sync(&handle, &loaded);`. `BootInfo` gains `modules: BTreeMap<String,bool>` (= host.state()). `save_settings`: inside the lock `if settings.modules_enabled.is_empty() { settings.modules_enabled = current.modules_enabled.clone(); }`; AFTER releasing the lock call `app.state::<ModuleHost>().sync(&app, &settings)` (never under the Shared lock: deadlock risk). Commands stay the 13 core ones (the 13th, `inbox_ingest`, lives in `core/inbox.rs`).

## TypeScript (M4b)

`core/moduleApi.ts` (types only + `resolveEnabled`):

```ts
import type { BotEmoteName, BotStateName, IslandMode, ViewLayout } from "./layout";
import type { Settings } from "./state";
import type { FsmState } from "../island/fsm";
import type { ViewActions } from "../views/views";
export type Disposer = () => void;
/** Higher wins, tie goes to the most recent. Optional neutral bands: BAND = { URGENT: 90, NOTICE: 60, ACTIVE: 30, AMBIENT: 10 }. */
export interface StatusLine { priority: number; text: string; icon?: string; ttlMs?: number; urgent?: boolean;
  /** Shown beside other pills in place of the mini grid (the timer). Default: only when no other pill. */ overGrid?: boolean }
export interface AvatarSignal { state: BotStateName; priority: number; emote?: BotEmoteName; ttlMs?: number }
export interface ViewHost { el: HTMLElement; sync(): void; focus?(): void; tick?(nowMs: number): void; readonly height?: number }
export interface ViewContext { actions: ViewActions; onResize(): void; api: IslandApi }
export interface ViewDef { name: string; layout: ViewLayout; tabOf?: string; lightsHome?: true; keyboard?: boolean; build(ctx: ViewContext): ViewHost }
export interface TabDef { view: string; title: string; icon(): Element; order: number; home?: true }
export interface Overlay { el: HTMLElement; active(): boolean; frame(nowMs: number): boolean; cursor?(x:number,y:number):void; place?(islandW:number):void; leaving?(nextView:string):void }
export interface HomeRequest { view: string; priority: number }
export interface IslandHooks { homeView(): HomeRequest | null; keepAwake(): boolean; pillOpen(taskId: string): boolean; avatarClick(): boolean; avatarPull(): void }
export interface IslandHost { // what Island lends the registry
  readonly actions: ViewActions; open(view: string): void; addRequest(owner: string, spec: RequestSpec): Disposer; hide(): void; collapse(): void; reveal(): void;
  setView(view: string): void; note(text: string): void; error(err: unknown): void; mouseInside(): boolean;
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
  island: { open(view: string): void; request(spec: { view: string; priority: number; pin?: boolean; ms?: number }): Disposer; busy(): boolean; setView(view: string): void; close(): void; wake(): void; hide(): void;
    keepAwake(pred: () => boolean): Disposer; isVisible(): boolean; mode(): IslandMode; fsmState(): FsmState; mouseInside(): boolean; view(): string;
    note(text: string): void; error(err: unknown): void; layoutHint(): void; redraw(): void; overlay(o: Overlay): Disposer };
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

`core/layout.ts`: `CoreViewName` typed union (core views only), `IslandViewName = string`, `VIEW_LAYOUTS: Record<string, ViewLayout>`, `viewLayout(v)` (fallback to `overview`/`empty`), `registerLayout(v, layout): Disposer`; `ViewLayout` gains optional `extraHeight` (was `proposalRoom`), `botCenter?: {top,h}` (card the auto-centred bot sits beside; default `{top:42,h:84}`), `botTrack: {from,span}`, `glow?: false`, and `islandSize/botPosition` read those instead of comparing view names.
`core/state.ts`: `modules: Record<string,boolean>`, `Settings.modulesEnabled: Record<string,boolean>` (default `{}`). `core/bridge.ts`: `BootInfo.modules`.

`island/island.ts` (the island becomes the host; hook points, NO module imports):
- `Island implements IslandHost`; `actions` becomes a field; `open(view)` = `forceHome` + `expand(view)` (navigation, never pins).
- Home transition: `const r = Requests.front(); this.expand(r?.view ?? State.defaultView());` (a waiting request wins over the home tab).
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
# catalog: one source, src/modules/*/manifest.json (cargo test catalog_matches_manifests, tests/catalog.test.ts)
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
| board | ON | TS only (no Rust, no `requires`). Owns the home tab ("Início") and the `overview` view; asks the owner of each pill for its card via `board.*` services (0.4.0) |
| claude | ON | Backend `src-tauri/src/modules/claude`, frontend `src/modules/claude`. Integration news on its finished/error cards comes through the `board.news` service; it provides `board.card`/`board.pill`/`board.focus` for its own pills |
| media | ON | Mochi drag-out ghost lives in the module (core hooks: `mochiDrop`, `Overlay.cursor(down)`). `attach_window` and the core `inbox_ingest` share `core/inbox.rs` |
| upload | ON, requires claude | The drop animation starts after the island opens |
| timer | OFF | Countdown and stopwatch |
| voice | OFF, requires claude | English only (Cactus `needle.exe` + Whistle model). The "go to alert" hotkey belongs to claude |
| github, vercel, stripe, n8n, resend, calcom, notion | OFF | One module per service (group "Integrações"). One shared scheduler, no task while none is on. Services used: `board.card`, `board.news`, `board.focus`; hook, `avatar.tint` |

Known limit: the compact grid shows at most 4 mini pills (display limit, not a limit on modules).

## Neutrality baseline

`npm run neutrality-audit` (fails by default, exit 1 on any finding; `-- --warn` only prints; `-- --verbose` lists lines; `npm run check` = tsc + test + idle-audit + this). Findings = hits in code, warnings = comment-only hits. Baseline at M0 (before M1/M2): **172 findings, 99 warnings**.

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
src/kit/code.ts                                0        12
src/kit/icons.ts                              1         7
src/kit/palette.ts                           0         4
src/views/views.ts                             4         0
TOTAL findings 172, warnings 99, allowlisted 4
```

After M1 (bridge split) the comment-only warnings dropped 99 -> 56 (findings unchanged: the typed calls only moved, `src/core/bridge.ts` is now clean). After M2 (CSS) and the audit allowlist update: see the latest `npm run neutrality-audit` output.

## Module CSS (M2)

- `src/style/index.ts` imports only the shared sheets (ui, core, text, kit panel/code, settings). Every module imports its own sheets from its `index.ts` (board: board; claude: base, chat, claude; upload; integrations (in `provider.ts`); media; timer).
- `src/main.ts` imports `./style` before anything that reaches `modules/index`, so module sheets land AFTER the shared ones (needed for ties such as `.sess-newbtn` vs `.btn`).
- Inter-module order = the glob order of `modules/index.ts` (M8: alphabetical by folder: claude, integrations, media, timer, upload, voice), NOT the catalog order. M8 moved only the upload sheet (after integrations/media/timer); the single selector pair that crosses (`#island.upload-on #bot-canvas` vs `#island.ghost-on #bot-canvas`) has identical declarations, so the cascade is unchanged. Sheets that were interleaved before (upload between claude chat and panel; integrations between claude panel and claude.css) now follow all claude sheets; checked: no tie between rules that can hit the same element.
- The settings window must never import a module `index.ts` (it would pull the island CSS: `html,body{overflow:hidden}`). It loads `src/modules/settings.ts` (`SETTINGS_SECTIONS`, glob of each folder's `settings.ts` export `settingsSections: Record<moduleId, SettingsSection>`); each module's `settings.css` is imported from its `settings.ts`. `ModuleDef.settings` was removed.

## Hooks and services (M3/M4)

Core hooks (generic, the island calls them): `homeView`, `keepAwake`, `pillOpen(taskId)` (a pill's arrow), `avatarClick()` (Mochi clicked; true = a module took it, no slap), `avatarPull()` (Mochi pulled out of the island).

Services are module-to-module and invisible to the core: `api.provide("<module>.<name>", impl)`, `api.use<T>(key)` (first provider) and `api.useAll<T>(key)`. Keys and types live ONLY in the owning module's `api.ts` (types only; consumers `import type`). They are dropped when the provider stops; a consumer treats `undefined` as "feature absent".

| Key | Provider | Consumer | Type |
|---|---|---|---|
| `claude.launchFile` | claude | media ("Abrir no Claude" entry), upload | `(path, ingest) => Promise<void>` |
| `board.card` | every module, for the pills it owns (claude: its session, idle and agent cards; each integration its own) | board home, left slot (first non-null) | `(taskId) => BoardCard \| null` |
| `board.news` | each integration, for its own pill | claude finished/error cards | `(taskId) => BoardNews \| null` |
| `board.pill` | claude (Claude's pill name, agents' badges) | board list | `(taskId) => BoardPill \| null` |
| `board.focus` | every module, for the pills it owns | board list (a click on a pill) | `(taskId) => void` (the owner calls `api.pills.focus`) |
| `board.host` | board | integrations (github: home is its panel while the board is absent) | `true` |

The board (`modules/board`, types in `board/api.ts`) owns the home. It draws the pill list and the empty note itself and nothing pill-specific: the left card of a pill is asked of the modules (`useAll`, lazy, first non-null; a pill nobody answers for gets a plain name card). Providers `import type` from `board/api`; the board imports no module. Without claude the board, the integrations and any module with pills work; with only the board on, home shows the empty note. `BoardCard` carries `key`, `build(actions)`, and optionally `sync`, `open` (the whole card is a button; the board plays the blip), `hint`, `room` (extra island height) and `target` (the arrow works). `askPill` lives in `kit/ask.ts`. Home tab and `overview` layout are the board's; `tabOf`/`lightsHome` keep lighting the tab flagged `home`.

## M6/M7 - settings, events and commands leave the core

`Module` (core/host.rs) gains default methods; the host loops over every module, so lib.rs names none:

| method | when | use |
|---|---|---|
| `setup(&AppHandle)` | once per module in the builder `setup`, on or off | register Tauri state only (claude: `pipe::Pending`). No threads, no timers |
| `migrate(&mut Settings) -> bool` | after load, before sync | legacy keys -> `modulesEnabled` / own keys; only fill what is missing |
| `on_save(current, incoming)` | `save_settings`, every module | keep Rust-owned keys (claude: wslHooks/wslPrompted/hooksInstalled), clean values (alertHotkey), legacy mirrors (voiceEnabled) |
| `boot(&mut Settings)` | `boot`, module on | refresh state the window must see fresh (claude: hooksInstalled) |
| `pause(bool)` | tray Pause, every module | integrations parks its scheduler (static flag, set even when off) |

`settings::fill_defaults(CATALOG, s)` is the only generic migration: ids still missing get `default_enabled`. `ModuleHost::migrate` runs the modules first, then it.

Core events are generic: `hotkey-error {name, error}` (one per registered name; "" = fine) and `inbox-added` (path of a file that came onto the island).

Module commands are named `<id>_*` (claude_*, media_*, voice_*, github_*, n8n_*; shared integrations use `integrations_*`). The list lives in `modules::handler!` (modules/mod.rs), which expands to one `tauri::generate_handler!`; lib.rs passes only the core commands: `modules::handler!(boot, save_settings, ...)`. A new module command is added in that macro.

## Pin request queue (M3)

`State.isPinned` is read-only and derived; modules never write it. A module asks for the screen with `api.island.request({ view, priority, pin?, ms?, quiet? })` (returns a Disposer; `core/requests.ts`, pure and DOM-free).

- One list in the core, each request stamped with its owner; all of a module's requests are disposed when it stops (its Scope). Front = highest `priority`, the newest wins a tie.
- `State.isPinned` = island expanded AND the front request has `pin`. `fsm.pinned` is written in ONE place (`Island.syncPin`). Esc, click-outside and the auto-close countdown only act when nothing is pinned.
- A new request that is not in front is queued: the view does not switch. A new front opens the island on its view (`quiet: true` queues and pins without opening, for a request that must not yank the view). Disposing the front shows the next request's view while the island is open; with no next one the pin is gone and the auto-close timer starts as usual. Disposing one request never touches another module's.
- `ms`: the request disposes itself after that long (replaces `open(view, {pinMs})`). `api.island.open(view)` is plain navigation.
- `api.island.busy()` (replaces `pendingAlert()`): true while any pinned request exists.
- "Aguardar" / any close: the island folds and the requests stay but are *parked* (they do not pin an unrelated view that opens later). Hovering the hidden island, or the next home transition, reopens on the front request, pinned again.
- `HomeRequest` has no `pin`: `homeView` only says where home is. Pinning is only through `request`.
- In use: claude approval 100 / question 90 (one request tracks the card in front, `Claude.syncRequest`), voice 40 (one request across listening, transcribing, review and error), media drop 20 with `ms`. A voice card never takes the screen over an approval; Esc on voice no longer unpins an approval and an approval being answered no longer unpins a voice transcript.

## Focus, pause and settings (M4 closing the back doors)

Modules read `State` (pills, focusId, mode, view) but never write it; the three things they used to write or cast go through the API.

- **Focus** (`api.pills.focus(id): Disposer`). Accepts a pill the module owns, or the pill being opened while a `pillOpen` reaction runs (`api.call("pillOpen", id)`); anything else is ignored. `core/pills.ts` owns the fallback: the first pill put in front when none is, and when the front pill is removed focus moves to the first one left. The returned function gives the front back to the pill it took it from, only if the module's pill still holds it and the old one still exists (integrations' GitHub news borrows the front this way). `State.focusId` is written only by `core/pills.ts` and the registry.
- **Pause** (`api.paused()`, `api.onPause(cb)`). `State.paused` is a getter; `main.ts` flips it with `State.setPaused(on)` (tray Pause / Settings / Open), which calls the listeners with the new value, once per change. A module's listeners go with its Scope.
- **Settings** (`api.settings<T>()`, `api.saveSettings(patch)`). The manifest declares `settingsDefaults` (key -> default; new keys start with the module id, old flat keys such as claude's `idleOpen` keep their names; `tests/catalog.test.ts` checks it). `settings()` is a frozen snapshot of those keys only (missing ones from the defaults); read it again after a save. `saveSettings` throws for a key not declared, updates the snapshot at once and sends only the given keys. The settings window gets the same through the section's argument (`SettingsSection = (s: ModuleSettings) => ...`, `core/moduleSettings.ts`).
- **Rust merge.** `save_settings(patch)` replaces the old whole-object save: under the `Shared.settings` mutex it merges the patch's top-level keys onto the stored settings (`settings::merge_patch`; unknown keys stay in `extra`, a wrongly typed known field refuses the whole patch), then runs `on_save` (Rust-owned keys survive) and writes the file as before (same bytes, corrupt-file guard in `load` untouched). The island's own saves send their one field; the settings window sends only the core fields (sound, intervals, screen, autostart, `modulesEnabled`) and never module keys, so a stale window cannot undo a `saveSettings(patch)` from the island, and the reverse. Two windows writing the same key: last write wins. Tests: `settings.rs` (`patch_*`), `tests/harness/api.test.ts`.
- **Lint.** `stateWrites` is 0 and the boundary lint fails by default (`--warn-lints` only prints). The remaining `stateImports` / `foreignCoreImports` are read-only or plumbing, each justified in `scripts/neutrality-ratchet.json` (`reasons`).

## Pills, badges, moods, sounds (M5 neutrality)

- **Pill** (`core/state.ts`): `{ id, label, color, mood, emote?, eye?, badge?, owner? }`. A module puts pills in the compact grid / overview row through `api.pills`: `set(pill, at?)` (a new pill needs `label` + `color`; later calls patch fields, `null` clears `emote`/`eye`/`badge`), `remove(id)`, `clear()`. `at`: `"start"`, `{ after: id }` (missing anchor = start), `{ before: id }` (missing anchor = end), default the end. The registry stamps `owner` (a module cannot touch another's pill) and removes all of a module's pills when it stops (focus moves off a removed pill). Modules never write `State.pills`. Data only one module needs (the steps of an agent pill) stays in that module, keyed by pill id.
- **Badge**: `"alert" | "done" | "error"` (`core/badge.ts`). Old names (`approval`, `finished`) are no longer accepted.
- **Mood** (`BotStateName`): `idle working thinking searching alert ask error done waiting sleeping dizzy`. Old names (`approval`, `question`, `finished`, `ratelimit`) are no longer accepted by `api.avatar.publish` / `api.pills.set`; `Mochi.setState` ignores unknown moods. Sound names are the neutral ones and match `sounds/<name>.wav`. Emote names are unchanged. View names (`approval`, `question`, `finished`) are Claude's own views, not moods.
- **Sounds**: neutral names (`SOUND_NAMES` in `core/sound.ts`) are the WAV file names in `sounds/`. `api.sound.register(name, url)` adds a module's own WAV (removed when the module stops).
- **Status priority**: the core only says "higher wins, tie goes to the most recent" (+ optional `BAND`). Numbers the shipped modules use today:

| Priority | Who |
|---|---|
| 100 | claude: approval pending |
| 90 | claude: question pending |
| 80 | error |
| 60 | finished (claude "pronto") |
| 50 | timer |
| 40 | voice |
| 30 | claude activity |
| 20 | media |
| 10 | integrations |

## How to add a module (M8)

Goal: a module is one folder, `src/modules/<id>/`. Nothing in `core/`, `island/`, `settings/` or `lib.rs` changes.

1. `manifest.json`: `{ "id", "label", "default", "requires"?, "group"?, "order", "devOnly"?, "settingsDefaults"? }` (an array when a folder holds several modules, as `integrations/`). `order` is start order and settings order (a requirement needs a lower `order`; ties break by id). `devOnly: true` = debug builds only (TS: `import.meta.env.DEV`; Rust: `#[cfg(debug_assertions)]` in the generated catalog), so release catalogs and `settings.json` never list it.
2. `index.ts`: exports a `ModuleDef` (`{ id, views?, tabs?, start(api) }`). `modules/index.ts` finds it by `import.meta.glob("./*/index.ts")` and takes every export that has `id` and a `start` function. Import the module's own CSS here. Use only `core/moduleApi` types and what `api` gives; never import another module (share through `api.provide` / `api.use`).
3. Optional `settings.ts`: `export const settingsSections = { <id>: (settings) => ({ el, dispose? }) }`; the settings window renders it while the module is on. Settings values live in the flat `settings.json` (unknown keys travel in `extra`): declare them in the manifest as `settingsDefaults` with keys prefixed by the module id, read with `settings.get<T>()` / `api.settings<T>()`, write with `settings.save(patch)` / `api.saveSettings(patch)`.
4. Optional Rust side, only if the module needs native code: `pub mod x;` + one entry in `registry()` + its commands in `handler!` (all in `src-tauri/src/modules/mod.rs`). A catalog id with no `Module` is fine: the host treats it as on/off by setting, with no start/stop.

Catalog: `build.rs` generates Rust `CATALOG` from the manifests; TS builds `MODULE_INFO` from the same files. Node tests cannot use `import.meta.glob`: `modules/resolve.ts` (`buildCatalog`, `collectDefs`) is pure and `tests/catalog.ts` feeds it manifests read from disk.

Honest limits: (a) Rust code still needs the three edits in `modules/mod.rs`; (b) glob order is alphabetical by folder, so module CSS must not rely on cascade order between modules; (c) `devOnly` modules' JS is still in the release bundle (never started, not in the catalog); (d) `order` must be unique in practice for a stable start order across modules written by different people.

## Shared UI kit and CSS conventions (0.3.1)

- `src/kit` is the shared, module-agnostic UI kit: `dom.ts`, `icons.ts` (header glyphs and icons used by 2+ modules), `format.ts`, `palette.ts`, a parametrised code/diff view (`code.ts`, `code.css`, `diff-*` classes) and the panel kit (`pane-*` classes, `pane.css`). Modules and core may import `kit/*`; `kit/` imports nothing from `modules/`, `island/`, `core/state` or `core/bridge` and its CSS uses no module prefix (enforced by `neutrality-audit`, scope includes `src/kit/**`). `src/views` keeps only the core header/views host (`views.ts`). `style/index.ts` imports `../kit/pane.css` and `../kit/code.css` at their old cascade positions.
- A module's own icons live in `modules/<id>/icons.ts` (`ICONS = { ...CORE, ...own }`). `tile-*` is the home card layout (`board.css`); modules dress their `board.card` in it.
- Module prefixes (`sess-`, `gh-`, `int-`, ...) are forbidden in core selectors: `neutrality-audit` derives them from `modules/*/*.css` and fails the build on a hit. The audit also fails on comments that name a module.
- Mood, badge and sound aliases of the old names were removed in 0.3.1 (`alert`, `ask`, `done`, `waiting`; `alert.wav`, `ask.wav`, `wait.wav`).

## Behavioural neutrality

`neutrality-audit` checks names; these checks look at behaviour. Both are in `windows/`.

- **Headless harness** (`npm run test:harness`, part of `npm run check`): vitest + happy-dom (`vitest.config.ts`, `tests/harness/`). `modules/index` and `modules/catalog` are mocked so the island boots with only `clock` (dev module) and `tests/harness/dummyModule.ts` (2 views, a pill, an overlay, a pin request; no Rust). Canvas, Path2D, `@tauri-apps/api` invoke/listen are stubbed and recorded; timers and rAF are fake. It asserts: greeting ends in compact, a status line shows, a click opens the home tab and the header lists every registered tab, `api.avatar.emote` reaches the engine, hovering the bot 1.9 s triggers `love` and `ensureRunning`, `Registry.apply` with no modules lands on `empty`, zero `console.error`, and no recorded command or event named `claude_`, `github_`, `voice_`, `media_` or `integrations_`. happy-dom does no layout, so geometry is not asserted. `tests/harness/requests.test.ts` drives the request queue through the island (two modules, priorities, `ms`, module stop, Aguardar + hover reopen).
- **Lints** (in `scripts/neutrality-audit.mjs`, FAIL by default when a count is above `scripts/neutrality-ratchet.json`, whose `reasons` justify what stays; `--warn-lints` only prints; `--write-ratchet` lowers it after a cleanup, counts never go up):
  - *Boundary*: `src/modules/**` must not value-import `State` from `core/state` (`stateImports`), write `State.<field> =` (`stateWrites`), or value-import core other than `core/moduleApi`, `kit/*` (`foreignCoreImports`). `import type` is always fine. Offenders are printed per module.
  - *Dead fields*: every field of `Settings`, `AppState`, `ViewLayout` and `IslandApi` must be read in `src/{core,island,views,mochi}` (`deadFields`). `IslandApi` is implemented by the core and read by modules, so its fields count as used when any file except `moduleApi.ts` and `registry.ts` reads them. A field only written, or only read by modules, is listed with how often modules mention it.
