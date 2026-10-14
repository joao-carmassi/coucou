# Porting status (branch refactor/modules)

The core is the island + the Mochi avatar. Everything else is a module on the module API
(docs/MODULES-CONTRACT.md). The pre-refactor code lives in git tag `m3-ok`
(`git show m3-ok:<path>`).

| Module | Default | Status | Notes |
|---|---|---|---|
| claude | ON | ported (M5) | backend `src-tauri/src/modules/claude`, frontend `src/modules/claude`. Integration news on its finished/error cards comes through the `taskNews` hook |
| media | ON | ported (M5) | Mochi drag-out ghost lives in the module (core hooks: `mochiDrop`, `Overlay.cursor(down)`). `attach_window` and claude's `ingest_file` share `core/inbox.rs` |
| upload | ON (requires claude) | ported (M5) | the drop animation starts AFTER the island opens (fixes the "0 %" bug) |
| timer | OFF | ported (M5) | |
| voice | OFF (requires claude) | ported (M5) | English only (Whistle/needle.exe); alert hotkey belongs to claude |
| github, vercel, stripe, n8n, resend, calcom, notion | OFF | ported (split) | 7 modules (one per service, group "Integrações"); one shared scheduler, no task while none is on; GitHub panel + pills; hooks `taskCard`/`taskNews`/`avatar.tint` |

Known gaps: (a) the integration badge clears on settle, not on pill focus; (b) the compact grid shows max 4 pills (display limit).
The idle "Nova sessão" card was never shown with Claude ON at m3-ok (not a regression).
Everything above is unverified at runtime until it has been run in the real app.
