# Idle baseline

Rule: island hidden and idle = about zero resources; a disabled module creates nothing.

## Run

```
cd windows
npm run idle-audit                                   # static: modules may not make raw timers/threads
powershell -File scripts/idle-measure.ps1 -Seconds 60   # runtime, read-only, needs Coucou running
```

`idle-audit` fails (exit 1) on a raw `setInterval/setTimeout/requestAnimationFrame` or a top-level
`addEventListener` under `src/modules`, and on `thread::spawn`, `async_runtime::spawn`, `spawn_blocking`,
`thread::Builder` under `src-tauri/src/modules`. Every exception is in the ALLOWLIST at the top of
`scripts/idle-audit.mjs`, one reason each. `core/host.rs`, `core/hotkeys.rs`, `core/island.rs` own the
raw calls and are outside the scan.

`idle-measure.ps1` samples every 5 s: main process CPU, threads, handles, working set, plus the
msedgewebview2 children. It prints the CPU delta (ms and % of one core), threads/handles first/last
and the busiest thread. Exit 1 if CPU > 50 ms per 60 s, or threads/handles grew.
Take the sample with the island hidden and with no Claude Code hook traffic.

## The floor (not zero)

- Coucou process, WebView2 browser, GPU, network and renderer processes stay alive.
- The 6 px invisible wake strip (window collapsed; the OS sends no cursor events).
- Parked threads: cursor poll (Condvar, parked while the island is hidden or collapsed, even with
  `compactHideInterval = 0`), tokio workers.
- Threads blocked in I/O by design: claude pipe accept loop, hotkey `GetMessageW` thread, media
  `ReadDirectoryChangesW` watchers.
- Not hidden (compact): cursor poll runs at ~60 Hz (hover needs it). Accepted floor of the visible state.

## Measurements

Installed build, taken 2026-10-13 with Claude Code hook traffic active (~1 event / 10 s):

| Run | Module set | Window | CPU (main) | % of 1 core | Threads | Handles | WS main | WebView2 WS |
|---|---|---|---|---|---|---|---|---|
| installed build | default | 31 min | 3453 ms | 0.19 % | 44 | 405 | 32 MB | 139 MB |
| installed build, hook traffic | default | 20 s | main thread ~3 % | n/a | | | | |

Hook events legitimately wake the UI.

Taken 2026-10-14 on v0.2.0, default module set, 120 s, no tool or hook traffic during the window
(`pwsh -File scripts/idle-measure.ps1 -Seconds 120`; Windows PowerShell 5 fails on the script):

| Process | CPU / 120 s | % of 1 core |
|---|---|---|
| coucou (main) | 250 ms (all in the first sample, flat after) | 0.21 % |
| msedgewebview2 (8 processes, sum) | 3406 ms | 2.84 % |

Threads 47 -> 46, handles 441 -> 446 (fluctuates 442-446, no growth trend). Main process is flat; the
WebView2 cost is the island being visible in compact (frame loop and cursor hover), not a module.
Not measured: per-module ON/OFF rows and hidden-island webview cost on this build.

Template, one row per module, hidden island, 60 s, no hook traffic:

| Module | State | CPU ms / 60 s | Threads start/end | Handles start/end | Busiest thread | Result |
|---|---|---|---|---|---|---|
| (none) | all OFF | | | | | |
| claude | ON | | | | | |
| claude | OFF | | | | | |
| media | ON | | | | | |
| media | OFF | | | | | |
| timer | ON | | | | | |
| voice | ON | | | | | |
| integrations | ON | | | | | |
| all | ON | | | | | |

Toggle each module 5 times and check threads/handles do not grow (log lines `[module] start|stop <id>`).

## Visible-compact cost

Measured on the installed build, island VISIBLE in compact mode (a Claude session 'working' => keepAwake):
Coucou-owned WebView2 GPU process ~24 % of one core, island renderer ~5 %, main ~1.5 %, continuously.

Cause: a looping avatar state (bounces/scans/breathes/zz/sweat) keeps `engine.busy` true, so
`island.ts` `frame` ran at the display rate (60 fps): full avatar canvas wipe + redraw (several gradients,
DPR up to 2), mini-bot redraws and `applyGeometry` style writes every frame; plus the
`#activity-line span` `background-clip:text` shimmer (infinite, 60 repaints/s, main-thread paint).

After (static estimate, not measured):
- compact + cursor away + no transition/emote/overlay: frame body runs at 30 fps (rAF callbacks skipped by
  time, geometry/emotes/greeting/hover/expanded keep full rate). Draw calls per second halved.
- shimmer animation uses `steps(60)`: 30 paints/s.

Re-measure: `pwsh scripts/idle-measure.ps1 -Seconds 60` (reports main + webview totals; keep the Claude
session 'working' and the island compact). Result row to fill in after a live run.
