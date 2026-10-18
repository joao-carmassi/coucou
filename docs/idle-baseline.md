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

`idle-measure.ps1` runs on Windows PowerShell 5 and pwsh. It waits `-Warmup` seconds (default 10), then
samples every 5 s for `-Seconds` (default 60): main process CPU, threads, handles, working set, and each
msedgewebview2 child (CPU per `--type`: gpu-process, renderer, browser, utility). Pass `-Hidden` when the
island is hidden. Exit 1 when:

- main CPU delta > 50 ms per 60 s (scaled to the window);
- threads grew by more than 3 (handles may fluctuate +-15);
- with `-Hidden` only: webview2 sum > 1 % of one core. Without `-Hidden` the webview2 % is informational.

The main limit is for the hidden island. A visible compact island fails it by design (60 Hz cursor poll,
130-440 ms per 60 s). Take the sample with no Claude Code hook traffic: any session event wakes the UI.

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

2026-10-17, v0.12.5, thread-level sampling (main thread tid, 5 s steps, window height logged): while the island is
VISIBLE compact the main thread (tao event loop) costs 10-25 ms/s (600-1500 ms / 60 s) and the GPU process 5-20 %;
once the window collapses to the 6 px wake strip it costs 0 ms for 35+ s. The island collapses `compactHideInterval`
(60 s) after the last event, and a running Claude session keeps it up for minutes. The "700-800 ms / 60 s" that
`idle-measure.ps1` kept reporting was the visible compact island sampled 10 s after an event, not a hidden-state
cost: there is no hidden-state leak. `-Hidden` now waits (`-HiddenWait`, default 180 s) for the wake strip before
sampling and exits 2 if it never appears.

Taken 2026-10-14 on installed v0.2.0, 60 s window after a 10 s warmup, default module set unless noted,
app restarted per run, `compactHideInterval` 3 (hidden) or 0 (never hide, visible compact). Other Claude Code
sessions were running on the machine, so hook events leak into some runs; those are listed, not discarded.

| Run | Main ms | Main % | Webview2 sum ms | Webview2 % | GPU % | Renderer % (both) | Threads | Handles |
|---|---|---|---|---|---|---|---|---|
| hidden, run 2 | 0 | 0.00 | 94 | 0.16 | 0.00 | 0.00 | 49 -> 46 | 427 -> 427 |
| hidden, run 3 | 0 | 0.00 | 63 | 0.10 | 0.00 | 0.00 | 49 -> 46 | 395 -> 395 |
| hidden, run 1 (event burst, not idle) | 1188 | 1.98 | 19422 | 32.4 | 12.4 | 16.5 | 49 -> 55 | 402 -> 545 |
| visible compact, run 2 (calm avatar) | 141 | 0.23 | 63 | 0.10 | 0.00 | 0.00 | 49 -> 46 | 404 -> 404 |
| visible compact, run 3 | 313 | 0.52 | 4859 | 8.10 | 3.05 | 4.19 | 49 -> 46 | 394 -> 397 |
| visible compact, run 1 | 438 | 0.73 | 7328 | 12.2 | 5.16 | 5.91 | 49 -> 46 | 388 -> 390 |
| all modules OFF, visible | 125 | 0.21 | 234 | 0.39 | 0.00 | 0.26 | 46 -> 43 | 402 -> 402 |
| all modules OFF, hidden | 0 | 0.00 | 203 | 0.34 | 0.03 | 0.08 | 46 -> 43 | 403 -> 403 |

Earlier 120 s sample (same build): main 0.21 %, webview2 sum 2.84 %.

Findings:

- Hidden: main 0 ms, webview2 0.10-0.16 % (WebView2 browser process, ~60-80 ms/60 s). Meets the rule.
  The hidden run that failed (32 %) coincided with a hook burst (threads +6, handles +143), not idle.
- Visible compact is bimodal, 0.1 % to 12 %, set by the avatar state, not by the window being shown:
  a calm avatar (run 2) costs nothing; a looping 'working' avatar costs 3-5 % GPU process + 4-6 % island
  renderer + 0.7 % WebView2 browser (+ 0.2-0.7 % main for the cursor poll). The 2.84 % sample was between.
- GPU process and island renderer cost about the same: the frame loop is the cost (one canvas redraw plus
  one composited present of the transparent window per frame). The WebView2 browser process adds ~0.7 %.
- All modules OFF with the island visible: 0.39 % total, so modules are not the visible cost; with the
  avatar calm there is no GPU or renderer work at all. All OFF hidden: 0.34 % (browser process 0.23 %).
- Threads and handles: no growth outside the event burst. Threads fall 49 -> 46 after the warmup.

Per-module ON/OFF rows are not measured. Template, one row per module, hidden island, 60 s, no hook traffic:

| Module | State | CPU ms / 60 s | Threads start/end | Handles start/end | Busiest thread | Result |
|---|---|---|---|---|---|---|
| claude | ON | | | | | |
| claude | OFF | | | | | |
| media | ON | | | | | |
| media | OFF | | | | | |
| timer | ON | | | | | |
| voice | ON | | | | | |
| integrations | ON | | | | | |

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

Measured (table above): the installed v0.2.0 shows 3-5 % GPU + 4-6 % renderer while the avatar loops,
far below the ~24 % + 5 % seen before the fps cap. Re-measure after a new build with
`powershell -File scripts/idle-measure.ps1 -Seconds 60` (add `-Hidden` when hidden).

Possible further reduction, not implemented: `IDLE_FRAME_MS` in `src/island/island.ts` (currently 60 ms,
~15 fps). Raising it to ~100 ms for the breathe/zz/scan idle loops would cut GPU and renderer cost about
in proportion (6 -> 10 fps) at the price of visibly choppier breathing. Pausing the loop after the avatar
has been idle and unhovered for N seconds (redraw on hover or state change) would drop it to the hidden floor.
