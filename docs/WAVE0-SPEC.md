# Wave 0 core additions (0.9.0): A1 A2 A3 A6 A7 A10 A11

> Note: the companion window (F59, section A7 below, `companionEnabled`) was removed in 0.13.1. Its mentions here are historical.

Spec written by the Opus advisor (task O0). Implementers read this file; deviations must be reported. Final text will be folded into `MODULES-CONTRACT.md`.

## Binding rules
- **Names.** The neutrality denylist = every `src/modules/*` folder + each manifest `id`/`label`/`group` + CONCEPTS (approval, session, overview, github, wsl, transcript, claude, voice, media). It grows with every new module folder (`agents`, `demo`, `weather`, `calendar`, `crypto`, `nowplaying`, `sysmon`, `eyecare`, `planusage`, `aistats` and their pt-BR labels). Core code, comments and settings copy never use those words (whole-word match). Write "timeout", not "timer"; "vitrine/showcase", not "demo". Existing banned labels: Timer, Painel, Soltar arquivo, Voz, Mídia, Relógio, Integrações.
- **Events.** New core events `presence` and `palette` go into `CORE_EVENTS` in `scripts/neutrality-audit.mjs`.
- **Dead-field lint.** Every new `IslandApi` leaf ships with a module that reads it in the same release (table at the end).
- **Idle.** With zero subscribers every addition costs no thread, no hook, no pipe and no timeout.
- Core Settings fields must be read in core (`paletteHotkey`, `mochiColors`, `islandPlacement`, `onboardedVersion`, `companionEnabled`).

## Host: `ModuleCtx::on_stop` (needed by A1, A6)
```rust
// core/host.rs
impl ModuleCtx { pub fn on_stop<F: FnOnce() + Send + 'static>(&self, f: F) } // stoppers: Mutex<Vec<Box<dyn FnOnce()+Send>>>
```
`set_enabled(false)`: set stop flag → `m.stop(&ctx)` → run stoppers in reverse (must not panic) → unlisten → `tasks.end`. Test: reverse order, each once.

## A1 Notices + presence
```ts
export interface Notice {
  text: string;
  priority?: number;  // BAND scale; >= BAND.URGENT ignores presence quiet; default BAND.NOTICE
  ms?: number;        // on-screen time once shown; default 4000, clamp 1500..15000
  key?: string;       // same owner+key replaces in place (clock restarts)
  view?: string;      // click on compact island while shown opens this view
  peek?: boolean;     // may reveal a hidden island to compact (never while quiet unless urgent)
}
// IslandApi.island.notice(n: Notice): Disposer   (all of a module's notices go when it stops)
```
No `icon` (core draws no StatusLine icon today). Urgency = `priority >= BAND.URGENT`, no extra flag.

Pure `core/notices.ts` (no DOM, no timeouts):
```ts
export const NOTICE_STALE_MS = 60_000, NOTICE_CAP = 12;
export class NoticeQueue {
  add(owner, n, now): () => void;        // key-replace; over cap drops lowest priority then oldest
  dropOwner(owner): void;
  front(now, quiet): Entry | null;       // highest priority, then OLDEST (FIFO); drops stale never-shown; quiet skips < URGENT
  shown(e, now): void;                   // starts on-screen clock once
  expired(now): boolean;
  nextDeadline(now): number | null;      // for ONE island timeout
}
```
Flow: `notice()` → if `State.paused` return no-op disposer → `add`; if queue was empty call `presence_watch(true)` → island puts the front into `Compact` under reserved owner `"#notice"` (`overGrid:true`); ordinary resolution applies (higher status wins; tie → notice). Clock starts on first `syncDom` where mode is compact and the status line is the notice. Expanded/hidden without `peek`: waits, clock paused (staleness still runs). One `setTimeout` armed at `nextDeadline` only while non-empty. Queue empty → `Compact.set("#notice", null)`, `presence_watch(false)`, nothing armed.
Click precedence on compact click: pinned front request > shown notice `view` > hold > last view > homeView > home tab > first tab > empty (notice consumed).
Peek: hidden island + front notice with `peek` (not quiet, or urgent) → `host.reveal()` compact only.
**Deviation (C4, accepted):** presence is watched only while `hideWhenBusy` is on AND (the island is visible OR the queue is non-empty): one blocked hook thread whenever the island is visible, none when hidden or the setting is off. A change into quiet folds the island (edge only; never over a pinned request or priority >= URGENT). Only a click (not reopen/hover wake) consumes a shown notice; a notice wins a priority tie against a plain status line; the queue going empty to non-empty re-asks the OS state.
Pinned approval (status 100) beats any notice burst. Burst cap 12. Pause drops all. Same key on screen: text changes, clock restarts.

Rust `core/presence.rs`:
```rust
#[derive(Serialize, Clone, Copy, PartialEq, Default)] pub struct Presence { pub quiet: bool, pub mic: bool }
pub struct Foreground { pub pid: u32, pub exe: String }  // file name lowercased, never window title
pub fn now() -> Presence;                                // SHQueryUserNotificationState + mic consent registry
pub fn quiet_of(state: i32) -> bool;                     // BUSY | RUNNING_D3D_FULL_SCREEN | PRESENTATION_MODE | QUIET_TIME
pub fn mic_in_use(entries: &[(String, u64)], own_exe: &str) -> bool;  // LastUsedTimeStop==0; ignores Coucou itself
pub fn on_foreground(ctx: &ModuleCtx, cb: fn(&AppHandle, &Foreground)); // shared WinEventHook thread, refcounted; ctx.on_stop unsubscribes
#[tauri::command] fn presence_now() -> Presence;
#[tauri::command] fn presence_watch(app: AppHandle, on: bool); // one subscriber; each foreground change emits `presence {quiet, mic}`
```
One `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT)` + `GetMessageW` thread, exists only while subscribers > 0 (stop like `hotkeys::quit_thread`). Quiet = `quiet_of(..) || mic`. Focus Assist is NOT covered. While quiet a waiting non-urgent notice neither shows nor peeks. Requests (approval) ignore presence.
Setting `hideWhenBusy` (default true) read in core. Tests: `tests/notices.test.ts` (pure), `tests/harness/notices.test.ts` (shows when compact; status 100 hides notice 60; hidden+peek reveals; quiet holds 60 shows 90; paused no-op; module stop clears; click with view opens; zero timeouts after empty; watch true/false pair), Rust `quiet_of`, `mic_in_use`. Consumer in 0.9: timer (T1).

## A2 Actions + palette
```ts
export interface ActionDef {
  id: string;                  // local; core stamps "<moduleId>.<id>"
  title: string;               // pt-BR
  keywords?: readonly string[];
  key?: string;                // one [a-z0-9]: Alt+<key> while the island has the keyboard; first wins, duplicates warn
  when?(): boolean;
  run(): void | Promise<void>; // throw/reject → api.island.error
}
// IslandApi.actions.add(def): Disposer
```
`actions.all()` / `actions.run(id)` ship only with their first reader (board F52 in 0.11, voice F41 in 0.12) because of the dead-field lint. Pure `core/actions.ts`: `Actions.add(owner, def)`, `all()`, `byKey(k)`, `search(q, extra)` (prefix > word-start > substring, accent-insensitive), `run(id)`.
Palette = core built-in view `palette` (input + matches + "Ir para <tab title>" for each `State.tabs`). Keyboard: in `syncDom`, `kb = expanded && (State.view === "palette" || !!viewDefs.get(view)?.keyboard)`.
Open: core setting `paletteHotkey` (Rust `palette_hotkey`, default `"Ctrl+Alt+K"`, `hotkeys::clean`), registered in `lib.rs` setup and on save via `hotkeys::set(app,"palette","Paleta",combo, emit "palette")`; island `listen("palette")` → `openPalette()`. Never a bare global Ctrl+K. In-window Ctrl+K only while the window has focus and target is not an input other than the palette's. `openPalette()`: if a pinned request is front call `reopen()`; else remember `prev={mode,view}` and `open("palette")`.
Central key handler in `island.ts` `wireInput` keydown, BEFORE the existing Esc line, in order: (1) view `palette`: arrows move, Enter runs then returns to `prev`, Esc `preventDefault` then `prev.mode==="expanded"` → `setView(prev.view)` else `collapse()`, then return; (2) Ctrl+K; (3) Ctrl+Tab / Ctrl+Shift+Tab while expanded cycle `State.tabs`; (4) `altKey && !ctrlKey && !metaKey && !repeat && /^[a-z0-9]$/` → `Actions.byKey` (`!ctrlKey` excludes AltGr on ABNT2); (5) existing `Escape && expanded && !isPinned → collapse()`.
Conflicts: claude Y/N acts only on view `approval` and ignores modifiers; voice Enter/Esc only on view `voice`; palette never opens over a pinned request. The island listener is registered before module listeners. Focus: the hotkey handler stores `GetForegroundWindow()`; `focus_window(false)` restores it if it still exists.
Tests: `tests/actions.test.ts`, `tests/harness/palette.test.ts` (event opens + `focus_window(true)`; typing filters; Enter runs/returns; Esc expanded returns, compact collapses; pinned blocks; Alt+key runs; Ctrl+Alt+key nothing; Ctrl+Tab cycles; module `y` handler on its own view does not fire), Rust `clean("ctrl+alt+k")`. Consumers in 0.9: timer ("Iniciar foco"), claude ("Ir ao alerta").

## A3 Mochi colour, brightness, level, idle life
Setting `mochiColors: Record<string,string>` (key = pill id | `"<prefix>*"` | `"main"`, value `#rrggbb`, else ignored; Rust `BTreeMap<String,String>`).
```ts
// core/pills.ts (pure)
export function colorFor(map, id, own): string;  // exact > longest prefix* > own
```
`targetBodyColor` uses `colorFor` on the focus pill; no pill → `map.main` else cream; `tintRequest` still wins. `createMiniBot`/`syncMiniBotStates` use `colorFor`. UI: rows (key,colour)+"main" in board settings (free-text keys v1).
Brightness (`engine.ts drawBody` ~:739): main Mochi (`!isMini`) with `bodyColor` keeps shading: `bodyShade(c: RGB): {top, bottom, ink}` pure (top +12% L, bottom −10% L OKLab; light ink when luminance < 0.32). Minis keep flat fill.
```ts
// IslandApi.avatar.level(v: number): void  // 0..1 loudness, squash ≤6%; calls < 33 ms apart dropped; decays to 0 in 300 ms; 0/never = inert
```
Host `avatarLevel(v)` writes `engine.level`, `ensureRunning` only when `v > 0.02`. Consumer in 0.9: voice (existing `voice-level` listener; `level(0)` in `Voice.leave`).
Idle life (engine only, no new timeouts, piggybacks on the compact frame loop): random glance; sleep after 10 min compact with no cursor in island and no non-idle mood (fallback `sleeping`; loses to any module signal; wakes on hover). Greeting v2 inside `mochi/greeting.ts`. Setting `mochiSleepMinutes` (default 10).
Tests: `colorFor`, `bodyShade`, level throttle/decay (fake timers), harness: hidden + level calls → no rAF.

## A6 Relay with channels (`core/relay.rs`, task C2)
```rust
pub struct Channel {
    pub name: &'static str,                       // [a-z0-9-]{1,24}; "" = messages naming no channel (legacy hooks)
    pub waits: fn(&Value) -> bool,                // does the sender wait for a reply? (then request_id is stamped)
    pub deliver: fn(&AppHandle, Value),           // must return fast
}
pub fn subscribe(ctx: &ModuleCtx, ch: Channel) -> bool;   // false if name taken; ctx.on_stop(unsubscribe); 1st subscriber starts the accept loop
pub fn ack(app, request_id); pub fn decline(app, request_id);
pub fn reply(app, request_id, line: &str) -> Result<(), String>;  // one line, no '\n', <= 64 KiB
pub fn pipe_name() -> String;                                     // unchanged \\.\pipe\coucou-<sid>
fn channel_of(v: &Value) -> Option<&str>;    // missing -> Some(""); invalid/too long/non-string -> None (dropped)
fn parse_line(buf: &[u8]) -> Option<Value>;  // first line, object only, MAX_PAYLOAD 1 MiB
async fn wait_reply(rx, ack: Duration, decide: Duration) -> Option<String>;
fn drop_channel(map, name);
```
Statics: `SUBS`, `PENDING` (replaces `claude::pipe::Pending` + its `setup`/`manage`), `LOOP`. Unsubscribe drops the channel's pending senders (waiting connections end with no reply; terminal takes over); last unsubscribe aborts the loop and the pipe closes. Constants unchanged: ACK 800 ms, DECISION 108 s, `first_pipe_instance` + 50×200 ms retry. No subscriber for a channel → finish immediately, no reply. Core logs only `relay ch=<name> id=<id> <first word>`.
Claude keeps in `claude/pipe.rs`: `CHANNEL{name:"", waits: |v| v["coucou_wait"]==true || v["hook_event_name"]=="PermissionRequest", deliver}` (profile_key normalisation, log line, `emit_to(island,"hook",payload)`) and the word mapping in `answer`/`answer_question` calling `relay::reply`. `claude_approval_*` commands and TS unchanged.
Hook exe (`hook/src/main.rs`), pure `parse_args(impl Iterator<Item=String>) -> Args{event, channel, agent, format, entry}`:
| flag | payload field | default | note |
|---|---|---|---|
| `--channel <c>` | `coucou_channel` | absent (= "") | installed Claude settings need no rewrite |
| `--agent <n>` | `coucou_agent` | absent | unchanged; legacy `--agent`-only still reaches claude `handleAgent` on "" |
| `--format <f>` | – | `claude` | picks input normaliser (→ hook_event_name, tool_name, session_id, cwd), whether it waits, reply JSON; non-claude formats wait only where the agent documents a blocking hook; transcript/proposal enrichment stays claude-only |
| `--entry <tag>` | `coucou_entry` | absent | which config wrote the hook; add only if `CLAUDE_CODE_ENTRYPOINT` (already forwarded as `entrypoint`) is missing for Desktop |
| derived | `coucou_wait: true` | – | set when the exe will read a reply |
Unknown `--x` skips its value and is never the event. `COUCOU_INTERNAL` guard unchanged. Old exe has no `coucou_wait`; claude `waits` still matches `PermissionRequest`. Agents (W2): installer writes `--channel agents --agent <n> --format <n>`, upgrades legacy entries with backup+diff+click; `ensure_hook_exe` moves to `relay::ensure_client_exe(app)` before agents ships (must work with claude off). An OLD exe takes an unknown `--flag` as the event name when the payload lacks `hook_event_name`: update the exe before agents installs hooks.
Rust tests: `channel_of`, `parse_line`, `wait_reply` (ack→decision, decision before ack, decline, ack timeout, decide timeout), `reply` refuses `\n`, `drop_channel`, hook `parse_args` (old forms `["Stop"]`, `["--agent","x","Stop"]`, new flags, missing value), `coucou_wait` only for claude PermissionRequest.

### Service contracts
```ts
// modules/agents/api.ts (types only)
export interface AgentInfo { id: string; label: string; color: string; installed: boolean; hooked: boolean; blocking: boolean; live: number }
export type AgentsList = () => readonly AgentInfo[];   // providers: agents + claude; consumers merge useAll by id
export interface UsageWindow { label: string; usedPct: number | null; resetsAt: number | null; tokens?: number }
export interface AgentUsage { agent: string; windows: readonly UsageWindow[]; source: "local" | "network"; at: number; error?: string }
export type AgentsUsage = (agent?: string) => Promise<readonly AgentUsage[]>;  // provider planusage; network only when opt-in key on
export const AGENTS_SERVICE = { list: "agents.list", usage: "agents.usage" } as const;
// modules/upload/api.ts (types only)
export interface DropAction { id: string; label: string; accepts: readonly string[]; /* ext lowercase, ["*"]=any */
  test?(paths: readonly string[]): boolean; run(paths: readonly string[]): void | Promise<void>; order?: number }
export const UPLOAD_SERVICE = { dropAction: "upload.dropAction" } as const; // one provide per action; upload renders useAll() as chips on `choose`
```
Services are pulled (no subscription).

### C2 order (safe)
1. `ModuleCtx::on_stop` + test; merge alone. 2. `core/relay.rs` (code moved verbatim from `pipe.rs`, pure fns + tests), not yet used; `cargo test` + neutrality. 3. Switch claude: `start` → `relay::subscribe`; delete `setup`(Pending) and Pending clear in `stop`; `pipe.rs` shrinks. 4. Hook exe `parse_args`, flags, `coucou_wait`, tests. 5. Manual regression below on a release build with real Claude Code; merge only if every step passes. 6. (W2) `ensure_client_exe`.

### Manual regression: approval path
1 Start Coucou: log `started`, no `cannot open the relay pipe`, hooks installed. 2 `claude` in Windows Terminal, un-allowed `Bash echo hi`: card appears, **Y** runs, log shows allow. 3 Same with **N**: "Denied from Coucou". 4 Edit shows diff → Allow, file changes. 5 AskUserQuestion answered on island. 6 ExitPlanMode plan-auto continues auto; plan-keep stays planning. 7 Tray Pause then request: terminal prompt < 1 s. 8 Request pending, switch Claude off in Settings: terminal takes over at once (no 108 s wait); switch on: new request works. 9 Quit Coucou mid-request: terminal prompt at once; restart works. 10 Request while island hidden opens card; with a fullscreen app in front still shows card. 11 Five notices then a request: approval + status 100 stay in front. 12 Request on screen: Esc does not close pinned card; Ctrl+Alt+K does not cover it. 13 WSL session approval (if configured). 14 Legacy shell-form hook `"…coucou-hook.exe" Stop` still updates pill. 15 `idle-measure.ps1 -Hidden` < 50 ms/60 s. 16 Claude off: no `coucou-<sid>` pipe left (`[System.IO.Directory]::GetFiles("\\.\pipe\")`).

## A7 Extra window (F59)
S0 spike PASSED in dev (runtime creation with identical `BROWSER_ARGS` renders, transparent, 60 fps; no restart needed). Re-test in a bundled build (`WebviewUrl::App`) and test click-through (`set_ignore_cursor_events`). Create via `run_on_main_thread` (never from a sync command); label added to `capabilities/default.json`; page in vite `rollupOptions.input`; build with the same `BROWSER_ARGS`; wait for a "ready" event ≤ 2 s else destroy + report error. Hidden window → low-memory target like `set_settings_webview_low`. Fallback if bundled test fails: create in `setup` before the island when `companionEnabled`, toggling shows "Reinicie o Coucou". No IslandApi field. Keep core window name `companion` only while no `modules/companion` folder exists.

## A10 Placement
Setting `islandPlacement: Record<string, number>` (key = `monitor_key`, value = logical dx from centre; Rust `BTreeMap<String,f64>`).
```rust
pub fn monitor_key(name: Option<&str>, w: u32, h: u32) -> String;           // "<name>:<w>x<h>" physical
pub fn place_x(mon_x: i32, mon_w: u32, panel_w: u32, dx_phys: i32) -> i32;  // centred + dx, clamped inside monitor
#[tauri::command] fn set_island_offset(app, shared, dx: f64);  // add to stored dx for current monitor, save (needs C1 atomic save), apply_geometry
#[tauri::command] fn center_island(app, shared);               // remove the key
```
`apply_geometry` uses `place_x` for panel and wake strip. TS: Alt+mousedown on compact island drags using existing `offsetX` spring; on release call `set_island_offset`, reset `offsetX` to 0 once moved; repeated drags add. v1: top edge only, Alt only (no handle). "Centralizar ilha" in Hub general section and tray. Tests: `place_x` clamps both edges incl. negative monitor x; `monitor_key`.

## A11 Hub
Search: pure `matchSections(q, [{id,title,text}]) → ids` (accent-insensitive) in `src/settings`. Presets: manifest `"presets": string[]` (ids `essencial`, `dev`, `tudo`, `vitrine`) set `modulesEnabled` from the catalog only. Export: `settings_export() -> String` pretty JSON with keys matching `/token|secret|password|api_?key|cookie/i` removed recursively; Import: parse, show top-level key diff, apply by click via `save_settings(patch)`. Onboarding: `onboardedVersion: string` ("" = first run opens Hub onboarding).
Safe mode: C1 already built `core/safe_mode.rs` (marker counter, threshold 3, `SAFE_MODULES`); C9 reconciles it with this spec: modules flagged manifest `"essential": true` (board) are the only ones resolved while active; in memory only, never saved; `quit_app`/tray quit clear (`clean_exit`); Hub banner "Sair do modo seguro" calls `safe_mode_exit` (clear, flag off, `host.sync(stored)`). Showcase mode = `vitrine` preset (core text never says "demo"). Tests: strike/clear in temp dir, resolve while active, `matchSections`, export filter.

## IslandApi leaves and their 0.9 readers
| leaf | reader in same release |
|---|---|
| `island.notice` | timer (T1) |
| `actions.add` | timer, claude |
| `avatar.level` | voice |
| later `actions.all` / `actions.run` | board F52 (0.11) / voice F41 (0.12) |

## Risks recorded by Opus
Denylist collisions (new module labels become banned core words); focus: island window is non-activating, so in-window shortcuts rarely work and the global `paletteHotkey` is the real entry; AltGr = Ctrl+Alt on ABNT2; `StatusLine.icon`/`urgent` are not drawn/used by core; `ensure_hook_exe` lives in claude; after C2, in-flight pipe connections end through dropped senders (check steps 8/9/16); presence has no Focus Assist, mic consent registry lists Coucou itself (exclude own exe); upload `requires: ["claude"]` so media drop chips vanish with claude off; a default palette hotkey keeps the hotkeys thread alive (+1 thread, 0 CPU); pipe trusts any same-user process (fake request can raise a card but never approve without a click); C1 atomic save must land before A10/safe mode writes.
