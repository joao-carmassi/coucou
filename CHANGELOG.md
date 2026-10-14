# Changelog

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
