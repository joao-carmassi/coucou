# Porting status (branch refactor/modules)

The core is the island + the Mochi avatar. Everything else was removed from the tree and
lives in git tag `m3-ok` (read it with `git show m3-ok:<path>`). A module is "ported" when it
runs on the module API (docs/MODULES-CONTRACT.md) and its folder exists under
`windows/src/modules/<id>/` and `windows/src-tauri/src/modules/<id>/`.

| Module | Status | Old code to port (at m3-ok) |
|---|---|---|
| claude | ts ported (branch m5-claude-ts, windows/src/modules/claude/); rust port in another worktree | rust: modules/claude/{pipe,hooks,sessions,local_claude,wsl,focus,files}.rs + lib.rs claude commands; ts: done (see the module folder; command names/shapes as at m3-ok) |
| timer | not ported | ts: modules/timer/{timer,view}.ts + timer.css |
| media | not ported | rust: modules/media/{media,capture}.rs; ts: modules/media/view.ts + media.css |
| upload | not ported | ts: modules/upload/{canvas,sequence,view}.ts + upload.css; island.ts drag/drop flow |
| voice | not ported | rust: modules/voice/voice.rs; ts: modules/voice/view.ts |
| integrations | not ported | rust: modules/integrations/*.rs; ts: modules/integrations/** (github, vercel, stripe, n8n, resend, calcom, notion) |
