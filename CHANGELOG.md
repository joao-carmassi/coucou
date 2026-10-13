# Changelog

## Unreleased

### Windows refactor (branch `refactor/modules`)

- Windows only: the app lives in `windows/`. The macOS and Linux builds are no longer on this branch; the entries below that mention them describe earlier releases.
- The API-key chat is removed. Claude Code sessions, approvals and answers stay.
- Core and modules: the island, Mochi, tray, settings, hotkeys and log are core. Claude Code, media, file drop, timer, voice and integrations are modules, switched on in Settings. A disabled module creates no tab, thread, timer or listener. See `docs/MODULES-CONTRACT.md`.
- New: a timer module (off by default).
- New: a media section (module `media`) on the island.
- New: voice module (off by default, English only).
- New: "Aguardar" on approval and question cards closes the island and leaves the request unanswered; nothing is sent.
- Idle cost measured and kept low: `npm run idle-audit` fails on raw timers or thread spawns outside the module API, and `scripts/idle-measure.ps1` samples a running app. Baseline in `docs/idle-baseline.md`.

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
