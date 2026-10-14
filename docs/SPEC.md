# Coucou: specification (Windows)

Behaviour of the island and Mochi. Sizes are logical pixels. Source of truth for visuals: `design/prototype/notch-buddy.html` and `design/captures/`. The code is authoritative where this file and the code differ; module structure is in `docs/MODULES-CONTRACT.md`.

## 1. Window

- One transparent, borderless, always-on-top Tauri window, fixed 720 x 320, centred at the top of the screen (primary screen or the one under the cursor, per Settings). The island is drawn inside it, glued to the top edge. It never takes focus, except when a text field in the island has it.
- Click-through: the transparent area never blocks clicks. A cursor poll (`core/island.rs`) decides, per frame, whether the cursor is over the island. The poll is parked while the island is hidden or collapsed.
- When hidden or collapsed the window shrinks to an invisible 240 x 6 wake strip at the top edge, the only thing that reacts to the cursor.
- There is no notch on a PC: hidden is 184 x 32, and the compact island fits its content.
- Shape: black, square top corners, rounded bottom corners, concave "ears" at the top corners so it merges with the screen edge.

## 2. Modes

| Mode | Size | Shows |
|---|---|---|
| `hidden` | wake strip only | nothing |
| `compact` | fits content, up to 360 wide, 32 high | Mochi (22), then the mini pills grid (max 4) or one status line |
| `expanded` | 640 wide, height per view | the current view |

Mini pills grid: 1 pill is 13 x 13, 2 are side by side, 3 or 4 are 2 x 2.

## 3. Behaviour

1. Nothing running: `hidden`.
2. Cursor on the top-centre wake strip: the island comes out and opens after a short dwell.
3. Something is running and the user is active: `compact`; Mochi follows the cursor with its eyes.
4. Hover on compact opens it; click on Mochi opens it at once.
5. Auto-close: an opened island folds after `autoCloseInterval` seconds without activity (Settings). Leaving the island does not close it. `Esc` closes unless the island is pinned.
6. After `compactHideInterval` seconds folded (0 = never) the island hides. After `absenceInterval` seconds without mouse movement it hides even with tasks; the first movement brings it back.
7. Alerts (permission, question, error) open the island on their own view, even when the user is away, and keep it open until answered or deferred with **Aguardar**.
8. Finished: the island opens on the `finished` card, then folds.
9. Several alerts: queued, one at a time, in arrival order; the card shows how many wait.
10. Focus: the big Mochi stands for the focused task; the others are mini pills. Clicking a mini pill focuses it. A pinned card (island pinned open) keeps **Aguardar** like any other.
11. Pause (tray) stops the island from looking at hook traffic and stops the service scheduler.

Status line (compact, no other pill, or `overGrid`): one at a time, highest priority wins, tie goes to the most recent: approval 100, question 90, error 80, finished 60, timer 50, voice 40, Claude activity 30, media 20, services 10.

## 4. Animation

- Opening: ~520 ms spring with slight overshoot. Closing: ~340 ms ease without overshoot.
- Width, height, radius, Mochi position and size, and the mini pills move together (shared-element feel).
- View content leaves in 160 ms (fade, blur, scale 0.97) and enters in 300 ms after a 160 ms delay.
- While compact with the cursor away and nothing moving, the frame loop runs at 30 fps; otherwise at display rate. Hidden: no frames.

## 5. Views

Common: header with tabs (from the modules that have one) and sound button; cards radius 20 on `#141518`; a coloured wash from the bottom matches the task state. Views other than `overview` put the other tasks in a column on the right.

| View | Owner | Content |
|---|---|---|
| `empty`, `confused`, `note`, `settings`, `greeting` | core | idle card, "too many slaps", short message (closes by itself), settings, launch greeting |
| `overview` | claude | focused task card (title, current step with its icon and target, lines it read or the diff), pills on the right |
| `approval` | claude | permission request: command or diff; Aguardar, Negar, Aprovar (plan mode: Aguardar, Continuar planejando, Manual, Modo auto) |
| `question` | claude | the question with options; multi-select, "Other", skip, Aguardar |
| `error`, `finished` | claude | failed or finished turn; Claude's reply |
| `sessions` | claude | list of sessions over all profiles; start, resume, focus |
| `session` | claude | session panel: steps on the left, journal on the right |
| `media` | media | recent screenshots, recordings, dropped files |
| `timer` | timer | countdown and stopwatch |
| `upload`, `uploading`, `choose` | upload | drop zone, progress (Mochi is the bar's cursor), "open in Claude Code" |
| `voice` | voice | transcript review card with **Enviar** |

A service module adds a pill and a card in `overview` (GitHub also a panel). Layouts (height, Mochi position and size, agent layout `none | grid | pills | column`) are registered per view (`core/layout.ts`); the window height is at most 320.

## 6. Mochi

Canvas 2D (`src/mochi/engine.ts`), a port of the prototype's `Bot` class.

- Body: superellipse, cream gradient, tinted from the bottom by the state colour; soft shading and highlight; pink cheeks that follow the gaze.
- Eyes: ink, projected on a sphere (yaw, pitch, roll) and clipped by the silhouette, which makes the rolls possible. Gaze follows the cursor with lag. Random blink every 2.2 to 5.4 s.
- Mini pills use the same engine with the body tinted by the pill colour.
- Halo behind the body in the state colour.

### States

`idle`, `working`, `thinking`, `searching`, `approval` (small loop jumps), `question` (head tilt), `error` (shake), `finished` (full roll, sparkles), `ratelimit` (sweat), `sleeping`, `dizzy` (double roll).

| State | Colour |
|---|---|
| idle | `#E6E9EE` |
| working | `#3B9EFF` |
| thinking | `#8B5CF6` |
| searching | `#6366F1` |
| approval | `#F5A524` |
| question | `#22D3EE` |
| error | `#F4505E` |
| finished | `#34D399` |
| ratelimit | `#FB923C` |
| sleeping | `#94A3B8` |
| dizzy | `#F472B6` |

Modules can publish an avatar signal (state, priority, optional emote, ttl); override beats the strongest signal, which beats the focused task's state.

### Emotes

`love` (pointer still on Mochi for ~1.9 s), `surprised` (picked up), `proud`, `wink`, `yawn` (before sleeping), `happy` (after a decision or a swallowed file), `annoyed` (a slap).

### Interactions

- Hover (expanded): blink, eyes grow. Click in compact opens. Click in expanded is a slap: squash, annoyed, sounds `slap` + `annoyed`.
- 3 clicks within ~1.7 s: `dizzy`, `confused` view, then back.
- Drag Mochi (module `media`): a floating Mochi follows the cursor; dropped on another window it captures it and opens a Claude Code session with the screenshot; elsewhere it returns to the island.
- Drag a file onto the island (module `upload`): Mochi turns into a box and swallows it (`gulp`), progress view, then the choice to open it in Claude Code. Several files use the same flow.

## 7. Sounds

28 WAV files in `windows/sounds/`. Default volume 0.12 (Settings range 0 to 0.2); on/off in the header and Settings. Events: `peek`/`greet`, `open`/`close`, `hover`/`blip`, `slap`/`annoyed`/`dizzy`, `work`/`think`/`search`, `approval`/`question`/`error`/`rate`, `finish`, `approve`, `gulp`/`tick`, `send`/`attach`, `love`/`pop`/`proud`/`wink`/`yawn`/`sleep`. No sound for silent updates.

## 8. Tray and settings

Tray: Open, Settings, Pause (*Pausar*), Quit. Settings window sections: Modules (one toggle per module; a dependent shows "Requer <module>" while its requirement is off), Claude Code (hooks per profile, WSL, alert hotkey, idle card), Services (token per service module), Voice, Sound, Behaviour (auto-close, hide, absence, screen), Startup. A module's section renders only while it is on.

## 9. Acceptance

- No lost click because of the transparent window.
- A Claude Code session is never blocked by the app (closed, crashed or slow: the terminal takes over).
- Hidden: about zero resources, and a disabled module creates nothing (`npm run idle-audit`, `docs/idle-baseline.md`).
- Core builds and runs with an empty module list.
