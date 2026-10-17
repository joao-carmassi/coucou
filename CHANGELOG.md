# Changelog

## 0.12.2

- Uso do plano: its own tab icon; the view sizes itself to its content (no scroll with two providers, scroll only past the panel limit).
- Pausas redesigned: Hoje / 7 dias tabs, break counters (taken of due), time since the last break, streak, per-app bars and a 7-day chart. Breaks are now recorded locally (counters only, `eyecare-breaks.json`, cleared by "Apagar dados").

## 0.12.1

- Removed the three buttons on the home card (open, flip, Utilidades) and the Utilidades view; the whole card still opens on click.
- Ctrl+Alt+K no longer opens a search field: it opens the island on the home, navigable by keyboard (Left/Right or Ctrl+Tab switch tabs, Enter opens the card, Esc folds). The palette was removed.
- Uso do plano: own tab icon; connection failures say what failed (timeout / no connection / other) and the cause goes to the log.

## 0.12.0

Wave 2: other agents, usage, statistics, richer Claude cards.

- New module **Agentes** (off by default): Codex, Cursor, Gemini CLI, Copilot CLI and OpenCode on the island. Hook installer per agent with backup, diff and an explicit click; removal only touches Coucou's own entries. Approval (allow/deny) only for Codex and Cursor shell, and only with the approve switch on. Cursor asks before every shell command once installed.
- New module **Uso do plano** (off by default): Codex limits read locally; Claude limits are opt-in (network + the Claude Code token, never refreshed). Pinnable line, notice at 90%.
- New module **Estatísticas** (off by default): tokens and estimated cost per day/model/project from local logs, counters only, read on demand when the view is open.
- Claude: finished card shows mode/effort/model chips and the full answer as safe Markdown; board card shows a live diff of the last edit; Windows Terminal tab is selected by UI Automation when possible; Claude Desktop chip.
- Board: two-face cards, "Utilidades" view with every action, "Último" chip; core gains `actions.all()` / `actions.run()`.
- Core: `core/cfgfile` (checked config edits) and `relay::ensure_client_exe` shared by modules.

## 0.11.1

- Pinned/last-opened lines are plain text: no shimmer, no slide-in; width changes in 16 px steps with hysteresis.
- Pin button sits at the top-right corner of the view (no longer pushes content down; views reserve room with `.pin-room`).
- Clima: taller view, hours and days strips without inner scrollbars; new setting to show the weather on the island every 15/30/60/120 min (even with the island hidden; skips on Pause or when busy).
- Sistema: height fits the content without scroll when temperatures are off (with temperatures: same height plus scroll); the usage line also shows after leaving the view during the focus time; GPU % added to the line (one PDH query, only while pinned).
- Fix: timer-glance test flake (timer clock read at call time).

## 0.11.0

One-line island feedback, reworked.

- One "Tempo de foco": the time the island stays minimized before hiding is now also the focus time (board primary pick). During it the compact line shows the last module you opened. The old "Voltar à aba" control is gone (`focusHoldMinutes` stays in settings.json but is no longer read).
- Pinned line: Tocando, Clima and Sistema ("Uso do PC": CPU and RAM %) can be pinned from their views (only one pinned at a time). It stays on the compact island until you unpin it, or its module has had nothing to show for 5 minutes. Approvals, questions, "pronto", reminders and the timer still pass over it, then it returns. Hub "Linha da ilha" shows what is pinned.
- Tocando and Clima no longer show their line unprompted: pin them, or see them for the focus time after leaving their tab.
- Timer: optional glance (every focus-time interval the timer's remaining time peeks, even with the island hidden).
- Sistema: height now follows what is visible (hide temperatures and the view shrinks).
- Core: `api.status.source/pin/pinned`, `api.island.focusMs`, `BAND.PINNED`, kit `pinButton`, source `icon` is drawn, urgent lines show beside other pills.

## Unreleased

- One "Tempo de foco": `compactHideInterval` now also times the board's primary pick and the implicit tab focus (the separate "Voltar à aba" control is gone and its value is not migrated: the reopen window is now the hide interval; `focusHoldMinutes` stays in settings.json, unused).
- Pinned line: new generic `api.status.source(key, { label, view? })`, setting `pinnedLine` (one at a time), `BAND.PINNED = 35`, last-opened module line for the focus time, auto-release after 5 min without content, `StatusLine.icon`/`dim`/`view` drawn, kit pin button, Hub section "Linha da ilha".
- Tocando and Clima publish their compact line as sources with a pin button in their views (they no longer show it unprompted). A pinned Clima refreshes every 30 min while the island is visible.
- Timer: optional glance (`timerGlance`) shows the remaining time every focus time, even when the island is hidden.

## 0.10.1

- Tocando: the main Mochi now dances (no second mini Mochi any more); with no agent task running, the compact island shows the cover, title, artist and time left. New generic `StatusLine.card` and `api.avatar.level(v, {dance})` options.
- Sistema: removed the top CPU/memory processes list (and its process scan); redesigned view with metric tiles, sparklines, disk/network rows and coloured temperature chips.
- Clima, Pausas, Agenda, Sistema, Tocando, Mídia: taller views, comfortable padding and themed scrolling so nothing is hidden (generic `.scroll` utility).

## 0.10.0

Five new modules (all off by default) and media tools.

- Tocando (`nowplaying`): what is playing through Windows media controls (title, artist, cover, play/pause/next/previous, progress when known), per-app volume, and Mochi dancing to the music (local loopback analysis only while playing and visible). Alt+P / Alt+N.
- Sistema (`sysmon`): CPU, RAM, GPU, disk, network and temperatures while the view is open; opt-in alerts; CPU temperature through LibreHardwareMonitor (read locally, or an opt-in pinned download with SHA-256).
- Clima (`weather`): current weather and forecast from Open-Meteo for a city you pick; no keys, no location lookup.
- Agenda (`calendar`): ICS calendar links (kept in Credential Manager) with recurring events and time zones, plus a reminder notice before each event.
- Pausas (`eyecare`): break reminders and screen time per app, stored only on this machine.
- Mídia: drop an image, PDF or video on the island and pick a tool: convert, resize, compress, strip metadata, copy, OCR, GIF/compress/audio (ffmpeg from PATH or an opt-in pinned download).
- Core: generic `user_idle_ms` and `foreground_now`; `api.provide`-based drop actions for the upload card.

## 0.9.0

Core foundation for the next modules (everything new is generic API, no module names in the core).

- Hardening: atomic settings save under lock, secrets only through a core secrets store, safe mode (3 unclean starts in a row run only the safe module set, in memory; leave it from the Hub), BOM-tolerant settings load.
- Relay: the hook pipe is now a channel relay that starts with its first subscriber; hook exe takes `--channel/--agent/--format/--entry`.
- Notices: `api.island.notice` queue on the status line, OS presence watch (full-screen, presentation, quiet hours, mic in use) and "hide when busy" option (on by default).
- Actions: `api.actions.add` and a command palette (Ctrl+K, Alt+letter, Ctrl+Tab, global hotkey Ctrl+Alt+K by default). Keyboard Y/N on an approval card is ignored for 500 ms and right after the palette.
- Island: Alt+drag to move it per monitor, "Centralizar ilha" in the tray and in settings.
- Mochi: colour per Mochi, idle glances, sleep and greeting v2.
- Hub: search, presets (essencial, dev, tudo), export/import without secrets, onboarding for fresh installs, safe-mode exit.
- Timer: pomodoro (work, short and long breaks).
- Dev: `npm run new-module` scaffolder, `npm run fake-agent`, example module "Exemplo" (off by default).

## 0.8.5

- Board primary: fix a picked pill (Vercel) staying in front on the mini island after the focus time, until the island was opened and closed again. The pick is now judged lazily on every visibility change (hover wake, open) as well as by the fold timer, and is dropped only once judged (a skipped attempt no longer loses it). An explicit default (Claude done/alert/error) now takes the front too.
- Claude: `focusPill` does nothing but set the focus while the island is not expanded, so a board revert can never open it; the board no longer needs to skip when a request is pending.
- The board logs its decisions (timer fired, pick-not-due, cur-explicit, applied) to the app log.

## 0.8.4

- Compact mini grid: with no status line on show (nobody working) every other pill is listed again, ambient integrations included (the compact grid still shows 4); while a status line shows, ambient pills stay out. Core only (`State.gridPills`, `State.statusLine`); `api.pills.others()` unchanged. The width follows the same list.
- Board primary: a pick no longer keeps the picked pill in front of a folded island. One scoped timeout (only while a pick exists and the island is folded) puts the default back after `focusHoldMinutes`; it never opens the island.
- Regression tests: news on a folded island (front or not) and ambient pills.

## 0.8.3

- New focus model. Implicit focus for every tab (core, no module code): leaving a view (tab change, or the island leaving `expanded`) remembers it; reopening within `focusHoldMinutes` (default 1) lands on it unless it is the home view. Unknown views are skipped; `0` turns it off.
- `api.island.hold` is now sticky: no time expiry (only with `opts.idleMs`); it ends by its disposer, the module stopping, or the user clicking the home tab. A live sticky hold beats the implicit last view.
- Focus is lost only by the home tab (clears implicit focus and all holds) or by the focus time (implicit focus only). Actions no longer drop it: removed the release-on-action from sessions (Retomar, Focar, Nova sessão), upload choose, the GitHub panel and media (Abrir, dblclick). Those modules lost their browsing holds; only the timer keeps a sticky hold (released when it finishes or is cancelled). A module can still release from an action by calling its hold's disposer.
- Settings: "Voltar à aba" (minutes after closing the island; 0 = always home).

## 0.8.2

- Clicking the home tab clears all task holds (home is the default).
- Home primary: setting "Principal do Início" (default Claude). Clicking an integration pill makes it the primary; after the island was closed for `focusHoldMinutes` it returns to the default. No timers.
- Timer and media retake their hold on each visit via `api.island.onChange` (no 1 s polls); media no longer releases the hold just by leaving the view.
- Module settings: per-module core-key exceptions; `save` refuses `focusHoldMinutes` and `modulesEnabled`.

## 0.8.1

- Fix: opening the sessions list, clicking outside and reopening right away landed on home. The list now takes a task hold (`api.island.hold`) when entered; opening or resuming a session, or starting a new one, concludes it. Leaving or collapsing does not.
- Same rule for the other unfinished views: upload's choose card (held until the choice, cancel or launch) and the GitHub panel while a sheet is open (released on back to the lists, or on open-in-browser). Voice already pins its review card with a request; board and home are not held.
- A hold is taken anew on each fresh visit, so one that expired no longer stays dropped (also fixes Mídia).
- Default focus time is 1 minute (`focusHoldMinutes`, `focus_hold_minutes`, settings window fallback). The countdown starts when the view leaves the screen: click outside, auto-close and compact hide all count.
- `api.island.reopen()`: unfolds a folded or hidden island like a click does (request, held task, home). The Claude "go to alert" hotkey uses it when nothing is pending.
- Version 0.8.1.

## 0.7.0

- Both audits have empty allowlists (`neutrality-audit`: 0 findings, allowlisted 0; `idle-audit`: 0 not allowlisted). `tests/audits.test.ts` (in `npm test`) fails if either list is not `[]` or an audit fails; a stale entry fails the audit.
- Composition root: only `src/boot/island.ts` and `src/boot/settings.ts` import `modules/`; core and settings import no module.
- `SettingsUi`: settings sections get `ui.timeout`, cleared when the section is rebuilt or the window unloads; no raw timers in modules.
- Rust `Spawner` / `SharedTask` (`ctx.spawner()`): every module thread and task is owned by the module and stops with it; the Claude hook pipe's in-flight connections are aborted when claude stops; the integrations scheduler is a `SharedTask`.
- Kit atoms for every kit class: new `paneCodeLead`, `fileRowOf`, `diffHunk` (and `row({file})`) replace the last literals; markup is byte-identical.
- Audit rule K3: modules may not spell kit classes (`pane-`, `tile-`, `diff-`, `code-`, `file-`, `hl`, `home`, `solo`, `left-body`, and `card`/`wash`/`view` as classes). Zero allowlist.
- Markup snapshot net: 105 tests in the harness.

## 0.6.1

- Removed `claude-home`: with the board off there is no Início (it looked like the board still being loaded). Home is the first tab (Sessões, timer, media...) or the "Nenhum módulo ativo" card.

## 0.6.0

- Rust modules are zero-edit: a folder `src-tauri/src/modules/<id>/mod.rs` (`PREFIXES`, `modules()`, `handler()`) is all a module needs; `build.rs` generates the registry and the prefix-routed commands and fails on prefix collisions. Audit rule R checks the TS bridges.
- Modules define their own Mochi moods, emotes and sounds (`api.avatar.defineMood/defineEmote`, `api.sound.register`, names `<moduleId>.<local>`), removed with the module; `api.avatar.glow(mood)` gives the glow of any mood. The last hard-coded glow table (`botGlowColor`) is gone.
- Generic kit builders (`panel`, `tile`, `row`) with public `pane-*`, `tile-*`, `diff-*` classes and the `--tile-inset`, `--pane-side-w`, `--pane-side-top` variables; Claude's sessions list, file list and idle cards and the integrations idle card use them (same markup). Audit rule K2 keeps modules out of the kit's class namespaces.
- The home layout (`.overview`, `.left`, `.right`, `.solo`, `.left-body`) is a kit sheet (`kit/home.css`) with a builder (`kit/home.ts`, `homeLayout`); the board uses it. Same CSS rules, same markup.
- `api.avatar.defineMood` rejects colours that are not `#RRGGBB` (error names the module); emotes are clamped when played (particles 0..12, ms 100..10000, blush 0..1). A removed mood makes live sprites fall back to idle on the next frame and a redefined one is picked up.
- The island follows the home when it moves (the board turned on or off while its Início or a fallback home shows).
- `build.rs`: a loose file directly under `modules/` is a clear error, comments in `PREFIXES` are ignored, and top-level `src/*.rs` changes rerun it; in release a module id missing from `CATALOG` is logged and a unit test checks every id.
- Kit: `tile` draws its status dot whenever `dot` is given (even an empty colour, as the old cards did); `panel` `side.sub` is optional.
- `scripts/css-rules.mjs` (new in 0.6.0) compares the built CSS rule by rule before/after a kit refactor.

## 0.5.0

- Modules reach the island only through the IslandApi: no `State`/`Bridge`/`Sound`/mochi imports; ratchet zero (stateImports, stateWrites, foreignCoreImports, crossModuleImports, deadFields all 0, enforced by `neutrality-audit` regardless of the ratchet file).
- API: `api.mochi.{mini,free,sprite}`, `api.pills` reads (`all`, `get`, `front`, `others`), `api.island.onChange/home/mouse/mouseLocal/redraw`, `api.sound.play`.
- Voice sends prompts via the `claude.launchPrompt` service instead of importing claude's bridge.
- Compatibility shims removed (`core/canvas`, `card`/`Wash` re-exports in `views`, `washRGBA`/`botGlowColor`/`PANEL_H`/`EXPANDED_W` in `core/layout`); unused exports dropped (`Bridge.quit`, `onDragDrop`, `BridgeEvent`, `STATE_SOUND`, `GREETING_END`, `releaseMiniBot`, `CoreViewName`).

## 0.4.0

- **Board module** (`board`, default on, TS only): owns the Início tab and the `overview` view. It asks the module that owns each pill for its card (`board.card`, `board.news`, `board.pill`, `board.focus`, typed in `modules/board/api.ts`), so pills of any module have a surface without `claude`. Claude provides its own pill's session card; integrations their own. `claude.taskCard`/`claude.taskNews` are gone. With only the board on, Início shows the pill list or an empty note.
- Clicking a pill in the Início list focuses it through its owner (`board.focus`).
- GitHub's home fallback now depends on the board being absent, not on `claude`.
- Pin request queue (`api.island.request`), `api.pills.focus`, `api.paused`/`onPause`, `api.settings`/`saveSettings` (typed per-module settings), shared UI kit in `src/kit`.
- Board stylesheet split out of claude's (same rules, new sheet order); `.jump` and `.icon-btn` moved to the shared sheet.
- `neutrality-audit --write-ratchet` keeps the `reasons` block of the ratchet file.

## 0.3.1

- The core no longer carries module content: module icons, GitHub/Claude CSS and the diff kit moved to the modules or became generic (`pane-*`, `diff-*`).
- Old mood/badge/sound aliases removed; WAV files renamed to `alert`, `ask`, `wait`.
- `neutrality-audit` also checks core CSS and comments.

## 0.3.0

Neutral core: the island and Mochi no longer know any module.

- Home is the Claude module's tab; with Claude off the island opens on the first enabled module's view, or a generic "no module" card.
- Modules are discovered from `src/modules/*/manifest.json` (TS glob; the Rust catalog is generated by `build.rs`). A TS-only module needs no edits outside its folder; `clock` (dev builds only) proves it.
- Module-specific bridge calls, CSS, settings, migrations, hotkeys and events moved into the modules; Rust commands are named `<id>_*` and listed through `modules::handler!`.
- New module API: pills (`api.pills`), services (`api.provide`/`api.use`), sounds (`api.sound.register`); generic badges (`alert`, `done`, `error`) and Mochi moods (`alert`, `ask`, `done`, `waiting`, old names aliased).
- `npm run neutrality-audit` fails the build if the core mentions a module.

## 0.2.5

- Voice: the card stays open while listening and while a transcript is on it; it was pinned in state but not in the island's state machine, so it folded by itself.

## 0.2.4

- Voice no longer stops on silence: it records until you press the hotkey again or Enter (Esc cancels), with a 10-minute safety cap.
- The voice transcript card stays open until Enter (send), Esc (cancel) or the new "Aguardar" button, which hides the island and keeps the text; hover or the hotkey brings it back.

## 0.2.3

- Mochi's "love" emote now plays on time after hovering him; the stopped frame loop only drew it once the mouse moved.
- A session that finishes (or fails) behind another one now reveals a hidden island; before, only the sound played.
- Settings: Claude Code, Soltar arquivo and Voz share one "Claude" group.

## 0.2.2

- Settings: upload and voice (which need Claude Code) are grouped under "Precisam do Claude Code".
- The Home button is hidden in the navbar while the Claude module is off.
- Voice: no review page; the transcript shows on the voice card, Enter sends, Esc cancels.

## 0.2.1

- Home falls back to the first enabled module's view (timer, media) instead of the "no module" card.
- Dragging Mochi onto a window captures it again (the release was always read as "dropped back home").
- Voice: the review text is editable and is sent only on Enter (Esc cancels).
- `idle-measure.ps1` runs on Windows PowerShell 5, with warm-up and scaled limits.

## 0.2.0

- Module architecture: the island, the Mochi avatar, tray, settings, hotkeys and log are core; everything else is a module switched on in Settings. A disabled module creates no tab, view, pill, timer, thread or listener. See `docs/MODULES-CONTRACT.md`.
- Windows only: the app lives in `windows/`. The macOS and Linux builds are no longer on this branch.
- Removed the chat and the Anthropic API key. Claude Code sessions, approvals and answers come from its hooks.
- New modules: `timer` (countdown and stopwatch), `voice` (hotkey dictation, on-device, English only), `media` (screenshots, recordings, dropped files, Mochi onto a window) and `upload` (drop a file on the island to open it in Claude Code). `claude`, `media` and `upload` are on by default.
- Integrations are one module per service (github, vercel, stripe, n8n, resend, calcom, notion), each off by default. The 4-pill limit is gone; the modules share one scheduler that does not exist while none is on. The compact island still shows at most 4 mini pills.
- "Aguardar" on approval and question cards, including pinned ones: closes the island and leaves the request unanswered; nothing is sent.
- Idle cost: `npm run idle-audit` fails on raw timers or thread spawns outside the module API, and `scripts/idle-measure.ps1` samples a running app. Baseline in `docs/idle-baseline.md`.

## Earlier releases

These entries describe the macOS and Linux apps, which are no longer on this branch.

- Declare the tools you use in Settings: Gemini CLI, Antigravity, Anthropic, Google AI and OpenAI pills join the existing ones (Cursor and Codex pills are coming soon), and you pick the main pill.
- Chat now supports Google AI (Gemini) and OpenAI in addition to Anthropic; switch provider and model by clicking the model name in the chat view, on macOS.
- Linux version: the Tauri app now builds for Linux too (AppImage, .deb, .rpm), with the island as a layer-shell overlay on Wayland and Claude Code hooks over a private Unix socket (#21) — thanks @Davy133
- Compact island on screens without a notch (#22) — thanks @Kamasoutra
- Only web links (http/https) open from the notch; other kinds of links from Claude or integrations are ignored (#16) — thanks @Cris1670
- Hook socket limited to your own user account, with size and time limits; logs no longer keep commands, n8n data or full URLs, and stay under 1 MB (#16) — thanks @Cris1670 and @Vignesh-Thangamariappan
- The island always reopens after folding, and Settings opens below it, resizable — thanks @rouderz
- Choose the Claude model for the chat in Settings; the list comes from your Anthropic account, and Claude Sonnet 4.6 stays the default — thanks @rouderz
- Windows build artifacts are now downloadable from a manual CI run — thanks @MysJofR
- Any agent can talk to Mochi: tag a hook payload with `coucou_agent` (e.g. `nb-hook --agent my-agent`) and it gets its own pill in the island (#7, #9) — thanks @lacatu5
- Gemini CLI and Antigravity (agy) hook support on macOS: install from Settings and their sessions show up in the island — thanks @corefusiion
