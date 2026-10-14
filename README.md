<div align="center">

<img src="windows/src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou

**Mochi, a small animated character at the top of your Windows screen, shows your Claude Code sessions and lets you approve, answer and drop files without leaving what you are doing.**

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![License: MIT](https://img.shields.io/badge/license-MIT-green)


</div>

---

This branch (`refactor/modules`) is Windows-only. The app lives in `windows/` (Tauri 2: Rust + TypeScript).
It has no chat of its own and needs no Anthropic API key: everything about Claude Code comes from its hooks.

## Architecture

- **Core** is always on: the island, the Mochi avatar, tray, settings window, hotkeys, log, Windows layer.
- **Modules** are optional and switched on in Settings. A disabled module has no tab, view, pill, timer, thread or listener.
- Core never imports a module. Contract: [`docs/MODULES-CONTRACT.md`](docs/MODULES-CONTRACT.md).

| Module | Default | What it does |
|---|---|---|
| `claude` | on | Claude Code sessions, approvals, questions, session panel, terminals, WSL |
| `media` | on | Screenshots, recordings and dropped files; drag Mochi onto a window |
| `upload` | on, needs `claude` | Drop a file on the island and open it in a Claude Code session |
| `timer` | off | Countdown and stopwatch |
| `voice` | off, needs `claude` | Hotkey dictation, on-device, English only |
| `github`, `vercel`, `stripe`, `n8n`, `resend`, `calcom`, `notion` | off | One module per service, one coloured pill each, read-only polling |

Known limit: the compact island shows at most 4 mini pills.

## Install

The installer is temporarily unavailable: Microsoft Defender flags the unsigned build as a false positive.
Build it from source (Rust, Node 20+, MSVC build tools):

```powershell
git clone https://github.com/Louis-CFM/coucou.git
cd coucou/windows
npm install
npm run tauri dev      # development build
npm run pack           # installer in windows/release/
```

## Setup

Tray icon, then **Settings**.

- **Claude Code**: *Install hooks* shows the diff, takes a dated backup of `settings.json`, and writes only after you click. If Coucou is not running the hook exits at once: Claude Code is never blocked.
- **Services**: switch a service module on and paste its token. Tokens go to Windows Credential Manager.

Details of the Windows app: [`windows/README.md`](windows/README.md).

## Docs

[`docs/MODULES-CONTRACT.md`](docs/MODULES-CONTRACT.md) module API and status, [`docs/SPEC.md`](docs/SPEC.md) behaviour,
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) Claude Code hooks and service modules, [`docs/AGENTS.md`](docs/AGENTS.md) other agents,
[`docs/idle-baseline.md`](docs/idle-baseline.md) idle budget.

## Privacy

No telemetry, no account. The only network requests go to the services you configure.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

- **Code:** [MIT](LICENSE).
- **Name, Mochi character, icon, sounds and media:** (c) Louis Raillé, all rights reserved, see [LICENSE-ASSETS.md](LICENSE-ASSETS.md).

[Website](https://louis-cfm.github.io/coucou/) · [Privacy](https://louis-cfm.github.io/coucou/privacy.html) · [Terms](https://louis-cfm.github.io/coucou/terms.html) · [Support](https://louis-cfm.github.io/coucou/support.html)
