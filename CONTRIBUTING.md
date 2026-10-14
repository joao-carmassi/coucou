# Contributing to Coucou

Windows only. The app is in `windows/`.

## Getting started

```powershell
cd windows
npm install
npm run tauri dev
```

Needs Rust, Node 20+ and the MSVC build tools. Read `CLAUDE.md` for the layout and `docs/MODULES-CONTRACT.md` for the module API.

## Good first contributions

- A new service module: copy an existing one (for example `stripe`): a provider in `src-tauri/src/modules/integrations/`, its pill and card in `src/modules/integrations/`, entries in both catalogs. See `docs/INTEGRATIONS.md`.
- A new agent: any tool gets its own pill by sending `coucou_agent` in its hook payload (see `docs/AGENTS.md`).
- A new emote or sound for Mochi.
- Bug fixes: describe how to reproduce.

## Rules

- Keep core and modules apart: core never imports a module. A module touches the app only through `IslandApi` / `ModuleCtx`.
- No raw timers or threads in modules. `npm run idle-audit` must pass.
- Secrets go to Windows Credential Manager, never to disk or git.
- No telemetry, no network calls except to services the user configured.
- Never block Claude Code. Never write `~/.claude/settings.json` without a backup and the user's confirmation.

## Pull requests

- One topic per PR, with a screenshot or GIF for anything visual.
- Before pushing, from `windows/`: `npx tsc --noEmit && npm run build && npm test && npm run idle-audit`, and in `src-tauri/`: `cargo check && cargo test`.
