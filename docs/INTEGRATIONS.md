# Integrations

Two kinds: Claude Code (module `claude`, through its hooks) and external services (one module each). The island has no chat and uses no Anthropic API key.

Official hook reference: https://code.claude.com/docs/en/hooks. Check it before changing event handling.

## 1. Claude Code (module `claude`)

```
claude (terminal, VS Code, Claude app, WSL)
  └─ hook ─► coucou-hook.exe ── named pipe \\.\pipe\coucou-<user-SID> ─► Coucou
                              ◄─ decision (PermissionRequest, questions)
```

- `coucou-hook.exe` is copied to `%LOCALAPPDATA%\Coucou\bin\` at launch. Source in `windows/hook/`.
- The pipe accepts the current user only. One instance per connection.
- `coucou-hook.exe [--agent <name>] [<Event>]` reads the hook JSON on stdin, adds terminal context and `coucou_agent` if `--agent` is given, and sends it.
- If the app does not answer within 300 ms, the hook exits 0 with no output: Claude Code carries on. It never blocks.
- Hooks are written in exec form (`command` = relay path, `args` = event), so no shell is involved. WSL uses `hook/coucou-hook-wsl.sh` in shell form (Settings, WSL section).
- Profiles: `~/.claude` and every `~/.claude-*` folder, one *Install hooks* row each. Coucou launches `claude.exe` with `CLAUDE_CONFIG_DIR` set to the profile.

### Events and state

| Hook | Effect |
|---|---|
| `SessionStart` | creates the task (name = folder or app), state `idle` |
| `UserPromptSubmit` | `thinking`, journal line with the prompt |
| `PreToolUse` | `working`, step = tool and target |
| `PostToolUse` / `PostToolUseFailure` | updates the step; a failure stays `working` |
| `PermissionRequest` | `approval` card |
| `Notification` | question or rate limit (`question`, `ratelimit`) |
| `Stop` | `finished` card with the first lines of Claude's reply |
| `StopFailure` | `error` card |
| `SubagentStart` / `SubagentStop` | step added |
| `SessionEnd` | removes the task |

Sessions started by a program (plugin review, SDK script) are ignored. Up to four sessions are followed.

### Approvals and questions

- On `PermissionRequest` the relay waits for the decision (110 s; the app answers at 108 s) and prints the hook decision JSON. No answer or app closed: no output, and Claude Code asks in the terminal.
- Buttons: **Aguardar** (closes the island, sends nothing), **Negar**, **Aprovar**. Plan mode offers **Continuar planejando**, **Manual**, **Modo auto**. Keys `Y` and `N`. Aguardar is also on pinned cards.
- An edit's permission card shows its diff. The relay reads the target file for that, read-only.
- Questions from the question tool show their options; pick one or several, type your own, skip, or hand back to Claude.

### Hooks installation (mandatory procedure)

1. Read `<profile>\settings.json` (create if missing).
2. Back it up with a dated suffix.
3. Merge Coucou's hooks without touching existing ones.
4. Show the diff, write only after the user clicks.
5. *Uninstall* removes only Coucou's entries.

### Other agents

See `docs/AGENTS.md`.

## 2. Service modules

One module per service: `github`, `vercel`, `stripe`, `n8n`, `resend`, `calcom`, `notion` (group "Integrações" in Settings). All off by default, no limit on how many are on.

- Each module owns one pill (`integration_<service>`). The pill id is a stable contract value.
- Shared code in `src-tauri/src/modules/integrations/`: fetchers, secrets, and **one scheduler** (`scheduler.rs`). The scheduler task exists only while at least one service module is on and configured; with none on, nothing runs. Tray *Pausar* parks it.
- A service polls only when its module is on and its key is in Windows Credential Manager. Keys never reach the frontend; the island can only ask whether one exists. Accepted key names are listed in `secrets.rs`.
- A change emits an `integration` event: the island sets the pill badge and plays a sound; the badge clears when the pill is focused.
- Requests are made by the Rust side, read-only, with a 10 s timeout.

| Module | First poll, then every | Keys |
|---|---|---|
| n8n | 3 s, 15 s | `n8n-url`, `n8n-api-key` |
| vercel | 5 s, 30 s | `vercel-token` |
| stripe | 6 s, 30 s | `stripe-api-key` |
| resend | 6 s, 60 s | `resend-api-key` |
| github | 7 s, 120 s (builds every 20 s while one of yours runs) | `github-token` |
| calcom | 8 s, 300 s | `calcom-api-key` |
| notion | 9 s, 300 s | `notion-api-key` |

GitHub also has a panel (activity, projects, pull requests, runs, threads) and news cards (broken build, merged pull request, new pull request on your project). Details and the token permissions: `windows/README.md`.

Each service answers for its own pill through the board's `board.card`, `board.news` and `board.focus` services (and `avatar.tint`), so neither the board nor `claude` imports a service module and the cards show without `claude`.

### Adding a service

1. Fetcher in `integrations.rs` and an entry in `PROVIDERS` (`scheduler.rs`) with its first delay and interval.
2. Key names in `secrets.rs`.
3. Module id in `providers()` (`integrations/mod.rs`), a manifest entry (`src/modules/integrations/manifest.json`; Rust `CATALOG` and TS `MODULE_INFO` are generated from it), and the frontend provider in `src/modules/integrations/`.
4. Keep the id order identical in both catalogs.

## 3. Dropped files (modules `upload`, `media`)

- Files dropped on the island are copied to `%LOCALAPPDATA%\Coucou\inbox` (originals untouched). Files older than 7 days are swept.
- `upload` plays the drop sequence, then offers to open the file in a new Claude Code terminal session with the file attached. It requires `claude`.
- `media` lists what Windows saved (`Pictures\Screenshots`, `Videos\Captures`) plus dropped files and Coucou's captures, newest first (max 300). It stores paths only and never deletes files.
- Dragging Mochi onto a window captures it and opens a session with the screenshot attached.

## 4. Voice (module `voice`)

A global hotkey (default `Ctrl+Alt+V`) opens the microphone. Recording runs through silence until you end it with the hotkey again or **Enter** (**Esc** cancels); the only automatic stop is a 10-minute safety cap. It is transcribed on-device by `needle.exe` with the Whistle model; the text appears inline on the same card that showed "listening" and is sent to Claude Code (a new session) only when you press **Enter**; there is no auto-send timer, **Esc** cancels, and **Aguardar** hides the island but keeps the text (hover or the hotkey brings the card back; while parked there is no timer and the island is not kept awake). The island takes focus and listens for Enter/Esc (a window keydown listener) only while listening or while the card shows. The model files are downloaded only from the Settings button (pinned revisions, SHA-256 checked). English only.

## 5. Timer (module `timer`)

Countdown or stopwatch on the island. While running it takes a status line (priority 50) beside the pills and keeps the island awake. A finished countdown plays `finish` and shows a note.
