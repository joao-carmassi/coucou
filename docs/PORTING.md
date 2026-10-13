# Porting status (branch refactor/modules)

The core is the island + the Mochi avatar. Everything else is a module on the module API
(docs/MODULES-CONTRACT.md). The pre-refactor code lives in git tag `m3-ok`
(`git show m3-ok:<path>`).

| Module | Default | Status | Notes |
|---|---|---|---|
| claude | ON | ported (M5) | backend `src-tauri/src/modules/claude`, frontend `src/modules/claude`. Integration news on its finished/error cards comes through the `taskNews` hook |
| media | ON | ported (M5) | Mochi drag-out ghost lives in the module (core hooks: `mochiDrop`, `Overlay.cursor(down)`). `attach_window` imports claude's `save_capture` (debt) |
| upload | ON (requires claude) | ported (M5) | the drop animation starts AFTER the island opens (fixes the "0 %" bug) |
| timer | OFF | ported (M5) | |
| voice | OFF (requires claude) | ported (M5) | English only (Whistle/needle.exe); alert hotkey belongs to claude |
| integrations | OFF | ported (M5) | one scheduler, no task when no provider is active; GitHub panel + pills; hooks `taskCard`/`taskNews`/`avatar.tint` |

Known gaps: pill badge on mini bots (`pillBadge`), idle "Nova sessão" card, keyframes `gh-swap`,
`gh-dim`, `gh-undim`, `gh-grow`, `gh-rise`, `gh-ghost`, `gh-live`, `gh-dot-in`, `gh-breathe`.
Everything above is unverified at runtime until it has been run in the real app.
