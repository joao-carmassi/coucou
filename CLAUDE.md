# Coucou — guide for AI coding agents

This branch (`refactor/modules`) is **Windows-only**: the macOS app (`NotchBuddy/`) and Linux support were removed. Everything lives in `windows/`. Mochi, a small animated character at the top of the screen, shows AI coding agent sessions (Claude Code, Gemini CLI, Antigravity and more) and a few integrations, and lets the user approve, answer, chat and drop files from the top of the screen.

## Where things are
- `windows/sounds/` — the 28 WAV sounds (served by Vite, copied into `dist/sounds`).
- `docs/SPEC.md`, `docs/INTEGRATIONS.md` — behaviour, views, states, integrations (in French).
- `design/prototype/notch-buddy.html` — original prototype, the visual source of truth. `design/captures/` — target screenshots.
- `windows/` — the Tauri app for Windows: Rust in `src-tauri/`, TypeScript in `src/`, the `coucou-hook` relay in `hook/`. `windows/README.md` lists what differs from the Mac.
- `docs/*.html` — the GitHub Pages site (privacy, terms, support, legal notice).

## Architecture (windows/)
- **Core** is always on: island, Mochi, tray, settings window, hotkeys, log, Windows layer. Core never imports a module. Front end `windows/src/core/` (module API in `moduleApi.ts`), `src/island/`, `src/mochi/`; Rust `windows/src-tauri/src/core/` (`host.rs` has `ModuleHost` and `ModuleCtx`).
- **Modules** are optional (claude, media, upload, timer, voice, integrations), switched on in Settings. A module reaches the app only through the module API and its `ModuleCtx`. A disabled module has no tab, view, pill, timer, thread or listener.
- **A module** is a folder `windows/src/modules/<id>` and `windows/src-tauri/src/modules/<id>`, plus one line in each registry: `MODULE_INFO` in `src/modules/catalog.ts`, `MODULES` in `src/modules/index.ts`, and `CATALOG` plus `registry()` in `src-tauri/src/modules/mod.rs`. Ids and order must match.
- Contract: `docs/MODULES-CONTRACT.md`. Porting status: `docs/PORTING.md`. Idle budget: `docs/idle-baseline.md`.
- `npm run idle-audit` (`windows/scripts/idle-audit.mjs`) fails on raw timers, top-level listeners in `src/modules`, and raw thread spawns in `src-tauri/src/modules`. Exceptions go in its ALLOWLIST with a reason. `scripts/idle-measure.ps1` samples a running app, read-only.

## Build and test
```
cd windows && npm install && npm run tauri dev
npx tsc --noEmit && npm run build && npm test && npm run idle-audit
cd src-tauri && cargo check && cargo test
```

## Rules
- No telemetry. Network calls only to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a Claude Code permission without an explicit click.
- Performance: 0 % CPU when the island is hidden.
- Never restyle what already ships (pills, cards, Settings, chat…): existing views stay exactly as they are in `main`, which is the App Store build. Change the look of an existing view only when explicitly asked.
- Pill IDs are stable contract values (Keychain, UserDefaults, hook routing): never rename an existing pill ID.
- New views follow the existing app style. `design/prototype/notch-buddy.html` and `design/captures/` are references for new work, not a reason to change existing views.
