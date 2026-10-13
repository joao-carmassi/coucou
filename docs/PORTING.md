# Porting status (branch refactor/modules)

The core is the island + the Mochi avatar. Everything else was removed from the tree and
lives in git tag `m3-ok` (read it with `git show m3-ok:<path>`). A module is "ported" when it
runs on the module API (docs/MODULES-CONTRACT.md) and its folder exists under
`windows/src/modules/<id>/` and `windows/src-tauri/src/modules/<id>/`.

| Module | Status | Notes / old code to port (at m3-ok) |
|---|---|---|
| claude | ported (M5, unreviewed: Gate D pending) | Backend `modules/claude/*.rs`, frontend `src/modules/claude/**`. NOT ported yet: integration news on finished/error cards, GitHub panel entry points, integration cards in the overview (they belong to `integrations`) |
| timer | ported (M5, unreviewed: Gate D pending) | `src/modules/timer/**`, default OFF |
| media | not ported | rust: modules/media/{media,capture}.rs + `attach_window`; ts: modules/media/view.ts + media.css |
| upload | ported (M5) | ts: modules/upload/{canvas,sequence,view}.ts + upload.css; island.ts drag/drop flow (provides on `file-drag`; uses claude's `launchFile` hook) |
| voice | not ported | rust: modules/voice/voice.rs; ts: modules/voice/view.ts |
| integrations | not ported | rust: modules/integrations/*.rs; ts: modules/integrations/** (github, vercel, stripe, n8n, resend, calcom, notion). Must provide the `openTarget`/`followNews` hooks and its own views; must not register a view named `overview` |
