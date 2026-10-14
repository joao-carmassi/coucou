# Coucou: guide for AI coding agents

Windows-only app (branch `refactor/modules`). Everything lives in `windows/`. Mochi, a small animated character at the top of the screen, shows Claude Code sessions and optional service pills, and lets the user approve, answer and drop files. No chat of its own, no Anthropic API key.

## Where things are
- `windows/`: Tauri 2 app. Rust in `src-tauri/`, TypeScript in `src/`, the `coucou-hook` relay in `hook/`, tests in `tests/`, scripts in `scripts/`.
- `windows/sounds/`: the 28 WAV sounds (served by Vite).
- `windows/README.md`: user-facing documentation of the app.
- `docs/MODULES-CONTRACT.md` (module API, status), `docs/SPEC.md`, `docs/INTEGRATIONS.md`, `docs/AGENTS.md`, `docs/idle-baseline.md`.
- `docs/*.html`: GitHub Pages site. `design/`: original prototype and target captures.

## Architecture
- **Core** is always on: island, Mochi, tray, settings window, hotkeys, log, Windows layer. Frontend `src/core/` (module API in `moduleApi.ts`), `src/island/`, `src/mochi/`; Rust `src-tauri/src/core/` (`host.rs`: `ModuleHost`, `ModuleCtx`). Core never imports a module (only `core/registry.ts` imports `../modules`).
- **Modules**: claude, media, upload, timer, voice, and one per service (github, vercel, stripe, n8n, resend, calcom, notion). Switched on in Settings; a disabled module has no tab, view, pill, timer, thread or listener.
- **A module** is a folder `src/modules/<id>` and `src-tauri/src/modules/<id>`, plus one entry in each registry: `MODULE_INFO` in `src/modules/catalog.ts`, `MODULES` in `src/modules/index.ts`, `CATALOG` and `registry()` in `src-tauri/src/modules/mod.rs`. Ids and order must match.
- Service modules share one library and one scheduler in `src-tauri/src/modules/integrations/`.
- Threads and timers go through `ModuleCtx` / the `IslandApi`, never raw. `npm run idle-audit` enforces it (exceptions in the ALLOWLIST of `scripts/idle-audit.mjs`, with a reason). `scripts/idle-measure.ps1` samples a running app.

## Build and test
```
cd windows && npm install && npm run tauri dev
npx tsc --noEmit && npm run build && npm test && npm run idle-audit
cd src-tauri && cargo check && cargo test
```

## Rules
- No telemetry. Network calls only to services the user configured. Keys live in Windows Credential Manager, never on disk or in the frontend.
- Never block Claude Code: if the app does not answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never approve a Claude Code permission or answer a question without an explicit click.
- Idle: about zero resources when the island is hidden (see `docs/idle-baseline.md`).
- Do not restyle shipped views unless asked. New views follow the existing style.
- Pill and task ids (`integration_<service>`, `agent_<name>`) are stable: never rename them.
