# Changelog

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
