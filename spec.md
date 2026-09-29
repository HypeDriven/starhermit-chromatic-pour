# Chromatic Pour — Game Design Document (running spec)

**Pitch:** Pour glowing layers of liquid between glass vessels on an alchemist's shelf until every vessel holds a single colour, in as few pours as you can.
**Genre:** Sorting puzzle (water-sort family) with seeded daily competition. **Players:** 1; asynchronous global/friends score comparison. **Round length:** 1–5 minutes (3 colours ≈ 1 min, 10 colours ≈ 5 min). **Session:** 5–20 minutes.
**Platforms:** Desktop and mobile browsers (Chrome, Firefox, Safari), portrait and landscape, no install. **Rendering:** Semantic DOM board (buttons + CSS gradient layers) is the playable surface; a Three.js scene draws the shelf environment, lighting and celebrations behind it and is fully optional.

This document describes the game as it runs today (present tense). Anything not yet implemented is listed only in §17.

## 1. File map

| Path | Role |
|---|---|
| `index.html` | Entry; import map (`three` → `vendor/three.module.js`, `three/addons/` → `vendor/addons/`), boot placeholder, critical CSS. |
| `starhermit.txt` | Platform manifest: `name=Chromatic Pour`, `launch=index.html`, `server=server.js`, `cover=coverart.png`. |
| `js/main.js` | Boot, GPU probe + Auto graphics preset, app state machine, rAF loop, lifecycle (visibility, resize, DPR), error surface. |
| `js/ui.js` | Every screen, the DOM vessel board, input (pointer, keyboard, gamepad), tutorial flow, settings, results, announcements. |
| `js/rules.js` | Pure rules engine: deal, legality, pour, scoring, hashing, solver, hint. No DOM, Date, or Math.random. |
| `js/content.js` | Colour sets, themes, difficulties, lessons, 40 journey stages, 6 challenges, daily/practice generators, par + content validation. |
| `js/session.js` | `GameSession`: clock, selection state machine, undo history, command log, replay envelope, snapshot/restore. |
| `js/storage.js` | localStorage persistence (settings, progression, bests, replays), checksummed save export/import, achievements. |
| `js/platform.js` | StarHermit adapter: launch token, profile, time sync, activity/presence, scores, leaderboard, achievements, telemetry. |
| `js/render.js` | Three.js ambient shelf: procedural wall/wood textures, lighting + shadows, image-based lighting, post-processing chain, adaptive resolution, motes and pooled particles, celebrations. |
| `js/gfx.js` | Pure graphics quality model: presets, categories, GPU detection, `resolve()`, `presetTier()`, `choosePreset()`, `describe()`. |
| `js/gfx-strings.js` | Graphics panel strings in the nine target locales, picked from `navigator.language`. |
| `vendor/three.module.js`, `vendor/addons/` | three.js r160 build and the matching r160 addons (EffectComposer and passes, GTAO/SMAA/FXAA/bloom shaders, RoomEnvironment). |
| `js/audio.js` | WebAudio: buses, sample one-shots from `sfx/`, synthesized fallbacks, generative music, per-theme ambience. |
| `js/rng.js` | xmur3 + mulberry32 seeded streams: `rulesStream`, `decorStream`, `audioStream`. |
| `server.js` | Zero-dependency static server + authoritative `/api/v1` (replay-verified scores, leaderboard, achievements, telemetry, presence). |
| `css/style.css` | Tokens, screens, board, responsive breakpoints, accessibility modes. |
| `assets/` | Key art and results illustrations (`title-art.webp`, `results-harmonized.webp`, `results-resists.webp`). |
| `sfx/` | 15 Opus clips; `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (generated). |
| `tests/run-tests.js` | 53 unit/golden/fuzz/graphics-model tests (`npm test`). `tests/e2e.mjs`: Playwright playthrough. `tests/server-regression.mjs`: API probe. |
| `tools/check-all.js` | Syntax check of every module (`npm run check`). Not shipped. |
| `coverart.png`, `icon.png`, `favicon.svg` | Store/launcher art. |
| `CONTRACTS.md`, `knownissues.md`, `LICENSE.md` | Module contracts, QA ledger, PolyForm Noncommercial 1.0.0. |

## 2. Vision and design pillars

Chromatic Pour is the water-sort puzzle reframed as an alchemist's evening ritual: patient, warm, and exact. The fantasy is a shelf of glass that you tidy into harmony, not a timer you race.

1. **The shelf is honest.** Every legal move is computable and shown: a lifted vessel highlights every legal target, a refused pour says why in words, the hint comes from the same solver that proved the level solvable. Rules in: solver-backed hints, explicit refusal messages, seeds shown and shareable. Rules out: hidden state, luck, boards that cannot be finished.
2. **One pour, one answer.** Each tap or key gets an immediate visual and audible reply (lift, clink, glug, thunk) and the round clock only runs while you can act. Rules in: input acknowledged in the same frame, animation skippable, undo free. Rules out: long unskippable choreography, penalties for thinking.
3. **Colour is never alone.** Ten shape badges, five palettes (standard + three colour-vision sets + high contrast), text labels on layers, and full ARIA vessel descriptions mean the puzzle is solvable without seeing hue. Rules in: badges on every layer, palette switch mid-round. Rules out: any mechanic that only reads through colour.
4. **Same recipe for everyone.** Boards are pure functions of a seed; the daily is one seed per UTC day; ranked scores are re-simulated from the command log on the server. Rules in: deterministic deal, replay envelopes, server-owned clock. Rules out: client-trusted scores, unverifiable boards.
5. **Glow that gets out of the way.** The 3D shelf, particles and music are ambience around the board, degrade by tier, and vanish entirely under reduced motion or without WebGL. Rules in: environment-only scene, CSS-only board. Rules out: gameplay information that lives only in the canvas.

## 3. Player experience

**Target player:** someone who enjoys short, tidy logic puzzles (water sort, Ball Sort, Sudoku-adjacent), plays in 3–10 minute pockets on a phone or during a break on desktop, and likes a daily to compare with friends.

**First 60 seconds.** A new player's Play button reads "Begin with a lesson" (`settings.tutorialDone` false; `ui.js playSubLabel`). Pressing it opens the Learn setup with five lessons; the first, *The First Decant*, puts a 2-colour, 4-vessel shelf on screen with an instruction card ("Vessels hold layers of liquid, bottom to top. Lift one by selecting it — select the first vessel."). Each step requires the player to perform the action; a wrong vessel shakes, plays the wooden thunk and toasts the step's hint text. Steps advance with the crystal chime. Lesson 2 deliberately asks for an illegal pour so the player reads the refusal. Completing any lesson sets `tutorialDone`, and Play then continues the Journey. Players who skip lessons still meet only 3-colour stages first, and the Help screen shows four rule cards drawn with live mini-vessels plus the current key bindings.

**Session shape.** Title → (daily card or Play) → 3–2–1 countdown → a round of 8–45 pours → results with a four-line score breakdown, stars (journey), achievements, personal-best delta and a "Next" button that already knows the next stage → repeat. A typical session is one daily plus two or three journey stages.

**Emotional beat.** The final pour: the last vessel fills, every tube glows uniform, the shelf sparkles, the bell motif rises, and the headline reads *Shelf harmonized!* The design serves that moment of order arriving.

## 4. Core loop and rules contract

Owner of every rule below: `js/rules.js` unless stated.

**Board.** `state.vessels` is an array of vessels; each vessel is an array of colour indices `0..colorCount-1`, bottom first (last element is the top). `capacity` is always 4. A level has `colorCount` filled vessels plus `emptyVessels` (2, or 1 on some mastery/challenge boards), so vessel count is `colorCount + emptyVessels` (5 to 12).

**Deal (`createGame`).** `dealPuzzle` shuffles `colorCount × 4` units with `rulesStream(seed).fork('deal-<attempt>')` and slices them into `colorCount` vessels; the empties are appended. Up to 60 attempts are made until the board is not already solved and `solve()` finds a solution of depth ≥ `max(3, colorCount − 1)` within 120 000 nodes; otherwise a 200-attempt fallback accepts any non-solved deal. Lessons pass explicit `vessels`. Same seed ⇒ identical board, in browser and on the server.

**Legal pour (`canPour(state, from, to)`).** In order of checking: round must be `active` (`game-over`); indices in range (`out-of-range`); `from ≠ to` (`same-vessel`); source non-empty (`source-empty`); destination not full (`dest-full`); destination empty or its top colour equals the source top colour (`color-mismatch`). The poured amount is `min(top run length, free space)` where the top run is the contiguous same-colour run at the top of the source (`topRun`). `legalPours` lists every legal pour; by default it omits "pointless" pours (a uniform vessel into an empty one), which is what hints and the solver use — play still permits them.

**Command (`applyCommand`).** `{id, type:'pour', from, to, elapsedMs}`. A missing id is malformed; a repeated id returns the original state with `duplicate:true` and no events. `elapsedMs` is clamped to be monotonic (`max(state.elapsedMs, requested)`). If `constraints.moveLimit` is set and `moves + 1 > moveLimit`, the pour is not applied and the round fails with `move-limit-exceeded` (a limit of N allows exactly N pours). Otherwise layers move, `turn` and `moves` increment by 1, the id is appended to `appliedCommandIds`, and events are `[{type:'pour', from, to, color, layers}]` plus `{type:'complete'}` when every vessel is empty or full-and-uniform (`isSolved`), or `{type:'failed', reason:'time-limit-exceeded'}` when `elapsedMs ≥ constraints.timeLimitMs`. Invalid attempts do not mutate; `recordInvalid` increments `invalidActions` (`turn` unchanged).

**Selection (`session.js selectVessel`).** No selection + non-empty vessel → `selected`; empty vessel → error `source-empty` ("Select a vessel with liquid in it first."). Tapping the selected vessel → `deselected`. Tapping another vessel → `pour(from, to)`; on `color-mismatch` against a non-empty vessel the tapped vessel becomes the new selection (`reselected: true`) so the fastest next action is one tap away. Pouring out of a finished uniform vessel is legal.

**Clock (`session.js`).** `elapsedMs` accumulates only while `_running` (started at `start()`, paused by `pause()`/tab hidden, resumed by `resume()`); each pour carries the current elapsed time. `restart()` returns to the initial state and zeroes the clock. `checkTimeout()` (called every frame by `ui.tick`) fails a timed round the moment the limit passes even without a pour, logging a `timeout` command.

**Undo / hint / restart.** `undo()` pops the previous snapshot; it is free (not a move, not a penalty), counted in `assists.undos`, refused when `constraints.noUndo` or the stack is empty. `hint()` calls `rules.hint`: the solver's first move if found within 60 000 nodes (`optimal:true`), else a heuristic over `legalPours` (prefer merging onto colour, filling a vessel, moving long runs; never disturb a finished vessel); counted in `assists.hints`. Hints can be hidden via the "Hints enabled" setting.

**Solver (`solve`).** Boards with ≤ 6 colours use breadth-first search (exact minimum depth); larger boards use weighted best-first with a breakpoint heuristic (near-optimal). `stateKey` sorts vessel strings so permutations of the same multiset share a key. Budget: 200 000 nodes default.

**Par (`content.js parFor`).** `par = depth + max(1, round(depth × 0.25))`, cached per `id|seed`; computed lazily on level start (never at import). Examples today: j01 par 11, j05 par 15, j20 par 23, j40 par 44; challenges 20–40.

**Score (`scoreState(state, par)`).** With `par` defaulting to `colorCount × 4` when unknown:
- completion = 10 000 if complete else 0
- moveEfficiency = complete ? max(0, (par × 3 − moves) × 150) : 0
- timeBonus = complete ? max(0, 3000 − floor(elapsedMs / 1000) × 10) : 0 (zero after 300 s)
- invalidPenalty = −50 × invalidActions
- total = sum; `breakdown` carries the four labelled rows shown on the results screen.

Worked example (journey stage 1, par 11): solved in 11 pours, 42 s, one refused pour → 10 000 + (33 − 11) × 150 = 3 300 + (3 000 − 420) = 2 580 − 50 = **15 830**. Solved in 20 pours, 2 min 10 s, no refusals → 10 000 + 1 950 + 1 700 = 13 650.

**Stars (`storage.js computeStars`, journey only).** 3 if moves ≤ par, 2 if moves ≤ ceil(par × 1.5), 1 for any completion; the best of previous and new is kept.

**Terminal states.** `complete/all-uniform`; `failed/move-limit-exceeded`; `failed/time-limit-exceeded`; `failed/abandoned` (`abandon()`, used by leaving a round). Once terminal, every pour is `game-over`.

**Tie-break (`compareResults`).** Completion first, then fewer invalid actions, then lower elapsed time, then session id string order. The server sorts a board by score descending and breaks ties with this order.

**Determinism.** `hashState` is FNV-1a over version, seed, colorCount, capacity, turn, moves, invalidActions, elapsedMs, status, terminalReason and the vessels JSON. The session records a hash at turn 0, every 4th turn and at the terminal turn; invalid attempts are logged as `type:'invalid'` commands because they change the hash. Cosmetic randomness (decor, audio pitch) uses separate streams and never touches rules.

## 5. Modes and progression

All modes share the rules above; they differ in content, constraints and ranking (`ui.js MODE_CARDS`, `content.js`).

| Mode | Board | Ranked | Assists | Notes |
|---|---|---|---|---|
| Learn | 5 lessons, 14 steps, explicit 2-colour boards | No | Hints always | Each step is its own session; step gates enforce the named vessel/colour/action. Completing any lesson sets `tutorialDone`. |
| Journey | 40 authored stages `j01`–`j40`, seed `journey-<id>-<theme>` | No | Undo, hints | Colour count rises 3 → 10 (`3 + round(idx × 7 / 39)`): 3,3,3,4,4,4,4,4,4,5 … 9,9,10,10,10. Every 5th stage is a mastery stage (◆); stage 35 (9 colours) has one empty vessel. Theme cycles ember → tidal → grove → umbra → aurum by index. Stages unlock in order (the first stage without a record is open; everything before it stays replayable). |
| Daily draught | `daily-YYYY-MM-DD`, seed = id, colours `5 + (dayOfYear % 4)`, theme by `dayOfYear % 5` | Yes | Allowed, recorded | Date from `platform.serverNow()` (UTC). Title card shows countdown to next UTC midnight and today's best. Server accepts only today's daily. |
| Practice | Apprentice 4 / Journeyman 6 / Adept 8 / Master 10 colours, 2 empties; any seed string (default `brew-xxxxxx`, re-roll button) | No | Undo, hints | Local best per difficulty board key `practice-<difficulty>`. |
| Challenge | 6 authored boards: The Measured Hand (6c, 40 moves), Ninety Heartbeats (6c, 90 s), The Lone Crucible (7c, 1 empty), No Backward Step (7c, no undo), The Grand Decant (10c, 300 s), Twin Fetters (8c, 60 moves + 120 s) | Yes | As constraints allow | Board id = challenge id; the HUD badge shows `Moves n / limit` (red within 3 of the limit) or the time limit; the timer counts down and turns red under 15 s. |
| Score chase | Master practice board with seed `chase-<date>` (Global daily) or `chase-evergreen` (Global all-time, Friends) | Yes | Allowed, recorded | Board keys `practice-master-chase-<date|evergreen>`; setup shows the top 10 from the API (or the local best offline). |

**Progression (`storage.js`).** `progression` holds per-stage `{stars, bestMoves, bestMs}`, per-day daily bests, achievement timestamps, the mastery roll, `sessionsPlayed`, and a daily streak (any completed round counts its UTC day; consecutive days extend it, a gap resets to 1). Achievements: First Pour (first completion), Mechanic Master (any mastery stage), Steady Hands (3-day streak), Adept Clear (8+ colours), Completionist (all 40 stages). Local bests per board key; the last 20 ranked replay envelopes are archived. The Progress screen shows stars, mastery count, achievements, rounds played, streak and best daily. Settings › Data offers checksummed export/import (`checksumDoc`/`verifyDoc`, FNV-1a over canonical JSON) and a double-confirmed reset.

## 6. Controls and interaction

| Intent | Desktop | Touch | Gamepad |
|---|---|---|---|
| Lift / pour | Click vessel; `Enter`/`Space` on focused vessel | Tap vessel (or press-and-hold 320 ms with "Hold to confirm") | A (button 0) on focused vessel |
| Move focus | `←`/`→`, `A`/`D` (wrap); `↑`/`↓`, `W`/`S` (by row) | — | D-pad / left stick, 300 ms auto-repeat |
| Cancel selection, else pause | `Esc` | Tap the lifted vessel again | B (1) |
| Pause / resume | `P` (rebindable) | Tray "Pause" | Start (9) |
| Undo | `U` | Tray "Undo" | X (2) |
| Hint | `H` | Tray "Hint" | Y (3) |
| Restart | `R` | Tray "Restart" | — |
| Recenter view | `C` | — | — |
| Skip pour animation | Click "Skip animation" | Tap "Skip animation" | — |
| Drawers (701–1023 px) | ☰ objective / ⚗ actions buttons in the top bar | same | — |

Bindings for confirm, cancel, pause, undo, hint, restart, camera and focus keys are remappable in Settings › Controls (press the control, then a key; `Esc` cancels) and persist in `settings.bindings`. Arrow keys and WASD always move focus.

**Input locking.** `inputLocked` is true from a pour until it settles: 560 ms with motion, 0 ms under reduced motion; the "Skip animation" button appears during the lock and settles everything instantly (`skipPour`, plus `renderer.skip()`). Undo/hint/restart and vessel taps are ignored while locked; the undo button is disabled visually. Typing in the seed field swallows game keys.

**Feedback per input.** Lift: vessel rises with a glow ring, legal targets get the `target-ok` outline, clip `select`, live-region text "Vessel 3 selected, Malachite, 2 layers." Pour: source `lifting`, destination `receiving`, new layers animate in with 70 ms stagger, `pour-start` then `pour-end`; a vessel that becomes full and uniform chimes `layer-complete`. Refusal: shake (or a red ring under reduced motion), `invalid`, assertive announcement of the reason. Hint: source/target pulse for 2.4 s, `hint`. Undo: `undo` + "Last pour undone." Countdown: `tick` on 3-2-1, `ui` on Go.

## 7. Screens and UI flow

**App state machine (`main.js ALLOWED_TRANSITIONS`).** `boot → title ⇄ profile-ready → mode-select → preparing → tutorial | countdown → active ⇄ paused → resolving → results → progression`, with `title`, `mode-select` and `preparing` reachable from results/progression, and `title` from any in-round state via "Leave to title". Every transition is logged to `window.__cpTransitions` with owner and reason; illegal ones warn and are refused.

**Screens (`ui.js`, one `<h1>` each):** *title* (wordmark over key art, Play with contextual sub-label, Daily and Journey cards, Practice/Challenge/Score chase buttons, Help/Settings/Progress/All modes), *modes* (six cards with ranked badge, duration, assists), *setup* (per-mode: stage grid, difficulty + seed, challenge list, daily panel with par, score-chase board picker + table, lesson list), *play* (left rail: objective, "Harmonized n of m vessels", limit badge, level name; playfield: canvas host + board; right rail: Undo/Hint/Restart/Pause, timer, move count; bottom tray on mobile), *results* (headline, outcome illustration, stars, score table, stats, assists, achievements, ranked note, best delta, Replay / Next / Change mode / View progress), *help* (four rule cards with mini boards, bindings table, lesson launcher), *settings* (Audio, Graphics, Controls, Accessibility, Gameplay, Data), *progression*.

**Overlays:** countdown (3-2-1-Go, 700 ms steps; "Go" only under reduced motion), tutorial card (lesson title, step n of m, instruction), pause dialog (`role=dialog`, focus trapped, `Esc` resumes: Resume / Restart / Settings / Help / Leave), confirm dialog (`alertdialog`, used for import and double-confirmed reset), "Settling the shelf…" note during `resolving`, toasts (max 4, 4.2 s), dismissible error banner (8 s auto-hide).

**Layouts (`css/style.css`).**
- ≥ 1024 px: three-column grid `minmax(12rem,16rem) | 1fr | minmax(12rem,16rem)`; rails visible; tray hidden.
- 701–1023 px: single column; rails become fixed slide-in drawers (width `min(18rem, 78vw)`) toggled from the top bar.
- ≤ 700 px (portrait phone): rails hidden; sticky bottom tray with four 44 px-minimum buttons (reversed for left-handed); playfield `min-height: 48vh`; vessels scale with `--slot-h: clamp(1.6rem, 4.2vw, 2.6rem)` and `--tube-w: clamp(2.9rem, 7.5vw, 4.2rem)`.
- Landscape ≤ 500 px tall: left rail as a narrow static column, right rail hidden, tray present, smaller slot sizes (`clamp(1.1rem, 6vh, 1.8rem)`), key art capped at 7 rem.
- Safe areas: top bar and tray pad with `env(safe-area-inset-*)`; `viewport-fit=cover`.

**Must never be cut off:** the full vessel row (wraps to multiple rows via the board's flex layout), the tray buttons, the timer/limit badge, the countdown, the results action row, and the pause dialog's Resume button.

## 8. Art direction

**Palette (base tokens, `css/style.css`):** background `#14100e` → `#1c1611`; ink `#ece2cf`, dim ink `#b3a488`; default accent `#e8a33d` (overridden per theme); danger `#e05d4f`; ok `#8fce6e`; focus ring `#ffd97a`; panels `rgba(41,32,25,.66)` with `rgba(236,226,207,.16)` borders and blur. High contrast swaps panels to solid `#1d1712`, dim ink to `#d5c8ab`, borders to 55 % ink, and removes blur.

**Themes (`content.js THEMES`, applied as `--theme-bg/fog/shelf/accent` and to the 3D scene):**

| Theme | bg | fog | shelf | accent |
|---|---|---|---|---|
| Ember Atelier (default) | `#1A0F0A` | `#3A1D12` | `#6B4226` | `#FF9E4A` |
| Tidal Sanctum | `#0A1620` | `#123043` | `#2E5A6B` | `#5AD1E6` |
| Verdigris Conservatory | `#0D1A10` | `#1C3524` | `#3E5A34` | `#8FD65A` |
| Gloaming Reliquary | `#0C0A14` | `#1E1830` | `#3A3050` | `#A78BFA` |
| Gilded Orrery | `#171207` | `#33270E` | `#6B5320` | `#F2C14E` |

**Liquids (standard set):** Emberwine `#D6402B`, Cinnabar `#E8830C`, Sungilt `#EFC618`, Malachite `#3FA34D`, Verdigris `#2AA198`, Azurite `#2B6CB0`, Amethyne `#6C4AB0`, Orchil `#C94F8A`, Umberdeep `#8B5A2B`, Mistveil `#9AA5B1`. Deuteranopia (Okabe-Ito + Tol), protanopia, tritanopia and maximum-contrast sets replace all ten; each colour index also carries one of ten SVG badges (drop, flame, leaf, star, moon, wave, gem, spiral, eye, rune) and an optional text label.

**Shape language.** Tall rounded-bottom tubes with a glass highlight, layers as glossy gradient bands, warm wood and brass. Cards and panels are rounded (14 px) glass over the theme gradient. The **hero** of every screen is the vessel row: everything else is dim serif text and quiet chrome.

**Typography.** Display and body: `ui-serif, "Iowan Old Style", Palatino, Georgia, serif`; numerals, labels, kbd and UI micro-copy: `ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif` with tabular numerals. Wordmark `clamp(2.6rem, 9vw, 5rem)`; "Pour" glows with the theme accent. Line length ≤ 70 ch. Larger-text mode scales the root to 1.2 rem.

**Motion.** Lift (translateY + glow), receiving pulse, staggered layer arrival, invalid shake, wordmark glow (4.5 s), countdown pop; 3D: camera spring framing, drifting embers/motes, celebration bursts, brief fail shake. Under reduced motion (setting or `prefers-reduced-motion`) all CSS animation collapses to 0.01 ms, refusals show a static red ring, the countdown is just "Go", pour lock is 0 ms, and the renderer cancels swoops, shakes and bursts while keeping event timing.

**3D environment (`render.js`).** ACES tone mapping at exposure 1.1, a warm hemisphere fill, one key light whose shadow frustum is fitted to the two shelves and the wall, a cool rim light, a flickering candle point light, theme fog 12–30 units. The canvas is sized from its own playfield box (not the window), so the scene is never stretched. Procedural wood/wall/flame textures come from `decorStream`; decor (books, candle on a brass dish, scrolls, potted sprig, bobbing emissive orbs) casts and receives shadows. Burst particles and drifting motes are soft round sprites on a non-raycast layer.

**Graphics.** Optional effects: key-light PCF shadows (512–2048 px maps), GTAO contact darkening, bloom limited to the candle flame, orbs and glowing draughts (threshold 0.9), a colour grade (gentle S-curve, warm highlights / cool shadows) with vignette, FXAA/SMAA/MSAA, image-based lighting from a PMREM-filtered `RoomEnvironment` (diffuse props take only a hint; brass and glass keep more), drifting motes and a 500-particle celebration budget (80 at the low tier), ambient background motion (candle flicker, orb bob, motes, flask glow; frozen under reduced motion), and a detail tier: laid-stone wall with a bump map, bumped wood grain, brass shelf trim and corbels, two stoppered specimen flasks, and on the DOM board cylinder shading on each liquid band, a bright meniscus on the top layer, a glass gloss streak and lip, a slow caustic sweep and a soft contact shadow (hues stay fully saturated in the centre of each band); on the title, a candle-warm glow and rising embers over the key art. The Settings screen's **Graphics** section offers a quality preset — Auto (detected from the unmasked GPU name: software renderers such as SwiftShader/llvmpipe get Low, discrete GPUs and Apple M-series get High, everything else Balanced; touch-only devices are capped at Balanced), Low, Balanced, High, Ultra — a render scale (50–200 %), one select per effect (Shadows, Ambient occlusion, Bloom, Colour grade, Anti-aliasing, Reflections, Particles, Background motion, Detail) defaulting to "From preset (…)", Adaptive resolution (averages 90 frames; above 26 ms the scale steps down 0.1 to a floor of 0.6, below 14 ms it steps back up 0.05), Show frame rate (a small fps · pixel-ratio readout), and a summary line "GPU · cost · W×H px", plus a note when post-processing is unavailable (the scene then renders without it) or WebGL is missing. Choosing a preset clears the overrides. Pixel ratio = min(device ratio, preset cap: Low 1, Balanced 1.5, High/Ultra 2) × preset scale (Ultra 1.25) × render scale × adaptive scale. Changes apply immediately (shadow maps, post chain, environment, detail, motes, resolution) and persist in the settings store under `graphics`; the old `quality` value is migrated once. Only canvas MSAA without post-processing is a context attribute, so switching into that mode takes effect from the next round. Low renders directly (no composer) at pixel ratio 1 with no shadows — no more work than the original renderer. The body carries `data-gfx-preset`, `data-gfx-detail` and `data-gfx-background` for the DOM layer and tests.

**Visual assets the design calls for:** title key art (shelf of banded vials over coals), a "harmonized" results illustration (uniform vessels with rising motes), an "unfinished" results illustration (jumbled vessels, hourglass, cooled coals), and a 16:9 cover reusing the key art. All four are shipped (§15).

## 9. Audio direction

**Mix philosophy.** Small glass-and-wood foley in front, a sparse generative melody behind, room tone under everything. Nothing is loud; the win motif is the only flourish. Four buses (`music`, `effects`, `ambience`, `voice`) with independent sliders (defaults 0.7 / 0.9 / 0.5 / 0.8); the voice bus has no content and is reserved. The context is created on the first pointer/key gesture, suspended while the tab is hidden.

**Music.** A generative loop in A-minor pentatonic (220–440 Hz motif pool) at 0.5 s steps: a note every other step with 25 % rests; a fifth-above harmony layer fades in once `intensity ≥ 0.35` and a low pulse joins at `≥ 0.7`, where intensity = harmonized vessels ÷ total vessels (`setMusicIntensity`). Melody choices come from the seeded `audioStream`, so a replay sounds the same.

**Ambience.** One of five families (warm, cool, tidal, verdant, gilded: two detuned drones + LFO + low-passed noise) chosen from the theme id; starts when a round goes active, cross-fades on theme change, stops on results/title.

**Samples.** After unlock, `audio.js` fetches `sfx/manifest.json`, maps each `event` to its clip, and lazily decodes `sfx/<name>.opus` on first play; every event keeps a synthesized fallback so the game is never silent if a clip fails. Each play gets a seeded ±4 % pitch variant.

**SFX event table (source of `sfx/manifest.txt`).**

| Event id | File | Sound | Usage |
|---|---|---|---|
| `select` | `select.opus` | Small glass vial lifted off wood, delicate clink | Vessel lifted |
| `deselect` | `deselect.opus` | Vial set back down, soft muted clink | Selection cleared |
| `pour-start` | `pour-start.opus` | Liquid starting to pour, rising glug | Legal pour begins |
| `pour-end` | `pour-end.opus` | Last drops trickling, soft splash | Pour settles, input unlocks |
| `invalid` | `invalid.opus` | Dull wooden thunk on a corked flask | Refused pour / wrong lesson action / nothing to undo |
| `layer-complete` | `layer-complete.opus` | Bright crystal chime with shimmer | A vessel becomes full and uniform; each lesson step done |
| `win` | `win.opus` | Rising sparkle of small bells | Round complete |
| `fail` | `fail.opus` | Descending two-note marimba droop | Move/time limit failure |
| `undo` | `undo.opus` | Quick reversed whoosh | Undo |
| `ui` | `ui.opus` | Very short wood tap | Buttons, cards, restart, "Go" |
| `hint` | `hint.opus` | Two soft glass-bell pings | Hint shown |
| `tick` | `tick.opus` | Single clockwork tick | Countdown 3-2-1 |
| `achievement` | `achievement.opus` | Brass bell then rising glass shimmer | Achievement unlocked at round end |
| `time-warning` | `time-warning.opus` | Three quick crystal taps | Timed round under 15 s (once) |
| `new-best` | `new-best.opus` | Ascending three-note glockenspiel | Results beat the stored personal best |

## 10. Localization

**Shipping today:** English only (`<html lang="en">`); every string is a literal in `js/ui.js` (screens, announcements), `js/rules.js` (`INVALID_MESSAGES`), `js/content.js` (lesson text, level and theme names) and `js/main.js`. The Graphics settings panel is the exception: its strings (`js/gfx-strings.js`) ship in all nine target locales and follow `navigator.language`. Score formatting uses `Intl.NumberFormat('en-US')`; times are `m:ss`. There is no language selector and no locale detection.

**Target locales (product requirement, not yet implemented):** en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. Layout already tolerates expansion: buttons wrap, cards use `auto-fit` grids, rails scroll, and `p` is capped at 70 ch — a 30 % longer label fits every control except the four-up mobile tray, which would need a two-row fallback. See §17.

## 11. Accessibility

- **Keyboard-only path:** every screen is reachable by Tab/Enter; on the board, arrows/WASD move between vessels, Enter/Space pours, `Esc` cancels/pauses; dialogs trap focus and restore it on close; `[data-autofocus]` targets receive focus on every screen change; focus ring is a 3 px `#ffd97a` outline.
- **Screen reader:** the board is a `group` of `button`s whose labels read "Vessel 3: 2 layers, top Malachite, single color"; polite live region for selections, pours, hints, undo, countdown; assertive region for refusals, timeouts and errors; results announce headline and score; pause/confirm are `dialog`/`alertdialog` with `aria-modal`.
- **Colour independence:** shape badge on every layer, optional text labels ("Labels on liquids"), four alternative palettes, high-contrast mode.
- **Motion:** reduced-motion setting and OS preference both honoured (§8).
- **Text and targets:** larger-text mode (1.2 rem root), all buttons ≥ 44 px, 8 px gaps in the tray, left-handed tray order.
- **Audio never required:** every cue has on-screen text; four independent volume sliders.
- **Assists:** hold-to-confirm (320 ms), hints toggle, tutorial replay from Help, remappable keys.
- **Errors:** categorised messages ("The 3D shelf could not be drawn — playing in classic view.") in a banner plus assertive announcement; the game keeps running.

## 12. StarHermit integration

Conventions per https://wiki.starhermit.com/ (game-scoped launch token, same-origin `/api/v1`, `starhermit.txt` manifest with `server=server.js`).

| Feature | Used | How (`js/platform.js`, `server.js`) |
|---|---|---|
| Identity | Yes | `#game_token=<jwt>` read from the fragment (query forms accepted for older launchers), decoded for `sub` and `game_scope`, never persisted; sent as `Authorization: Bearer` on every `/api` call. Standalone launch = guest. |
| Profile | Yes | `GET /api/v1/users/{sub}/profile` → nickname, else "Player <8 chars>" (usernames are never displayed); 3 tries, 2 s boot budget, late answer refreshes the chip via `onProfile`. Avatar is not fetched. Guest chip reads "Guest — sign in"; sign-in is host-shell only and says so honestly (no client login route exists). |
| Token refresh | Yes | Scoped tokens re-mint every 45 min via `POST /api/v1/games/{slug}/launch-token` while hosted (60-min token, ~60 s retry after a failed re-mint). |
| Server time | Yes | `GET /api/v1/time` with round-trip offset; daily date and countdown use `serverNow()`. |
| Activity / presence | Yes | `POST /api/v1/activity {start|end}` on entering/leaving a round; `POST /api/v1/presence` heartbeat every 30 s while active (min 25 s apart). |
| Leaderboards | Yes | `POST /api/v1/scores {board, entry}` only for completed ranked rounds (daily, challenges, score chase); entry carries level id, seed, content version, result and the full replay envelope. Server rebuilds the board from the id, checks seed and initial hash, re-applies every command, verifies periodic hashes, monotonic and non-zero elapsed time, terminal `complete`, and recomputes the score with its own par; rejects with 400/409 `stale-version`/422 (`unsupported-level`, `board-not-current`, `seed-mismatch`, `hash-mismatch`, `invalid-replay`, `not-complete`, `score-mismatch`)/429. Top 100 kept per board; `GET /api/v1/leaderboard?board&scope` returns the top 50 (`friends` returns the same list; the host filters). Offline: local best only. |
| Achievements | Yes | Local unlock in `storage.recordResult`; durable `POST /api/v1/achievements {key}` (idempotent) for the five static keys. |
| Telemetry | Yes, opt-in | Consent toggle in Settings › Data; only `start`, `tutorial-step`, `round-end`, `retry`, `settings-change`, `error` with numeric/boolean/short-enum payloads; queued (max 100), flushed every 10 s and on `pagehide`; server keeps aggregate counts only. |
| Server script | Yes | `server.js` is the distribution's static server (refuses `tests/`, `tools/`, dotfiles) and the authoritative API; JSON stores under `data/` (`CP_DATA_DIR` override); `PORT` env, default 8080. |
| Cloud save | No | Progress is local; export/import is a checksummed JSON file. |
| Sessions, rooms, matchmaking, chat, voice | No | Solo ruleset; nothing realtime. |

## 13. Technical architecture

- **Modules** are plain ES modules; `rules`, `rng`, `content`, `session`, `storage` run under Node (tests, server) and the browser. Only `render.js` imports `three` (vendored, no CDN). `main.js` dynamically imports storage → platform (3 s race against an offline stub) → render → audio → content, so any optional layer can fail without stopping boot; storage or content failure shows a fatal panel.
- **State ownership.** Rules state is immutable and only changes through `applyCommand`; `GameSession` owns clock, undo stack, command log and hashes; `ui.js` renders snapshots and sends intents; `main.js` owns the screen state machine. UI state (drawers, dialogs) is independent of simulation state.
- **Determinism and replay.** Envelope: `{schemaVersion, build, contentVersion, levelId, seed, initialHash, startedAt, commands[], stateHashes[], terminal}`. `GameSession.snapshot()/restore()` serialise a round for resume (used by the interrupted-session golden test).
- **Persistence.** localStorage keys `chromatic-pour:settings|progression|bests|replays|conflict:<ts>`; memory fallback when storage throws; all readers normalise malformed data.
- **Performance budgets.** rAF loop with dt clamped to 100 ms; renderer skips frames while hidden; pixel ratio capped per graphics preset with adaptive resolution; particles pooled and bounded per tier; post-processing only when an effect needs it; one canvas per round (disposed on level start); no per-frame allocation in `ui.tick` beyond text updates. The DOM board rebuilds on every state change (≤ 12 buttons × 4 slots).
- **How the e2e drives the real UI.** `tests/e2e.mjs` starts its own static server (ephemeral port or `PORT`), launches headless Chrome with SwiftShader, and clicks visible elements: Settings → Back, Settings → Graphics (Auto detects Low on SwiftShader; switch to Low then High, override Detail, enable the frame-rate readout, check `data-gfx-*` on the body and the summary, reload and verify everything persisted, then Auto clears the override), Journey card, stage 1, waits for `countdown`/`active` via `window.__cpTransitions`, presses `p`/Resume, `h`, reads the board from the DOM (`data-color` slots), asks `rules.solve` for the next move, clicks the two vessels, presses `u`, then solves to the results screen and checks the score table, action buttons and persisted progression — on 1280×800 and 390×844 (touch), then a hosted pass with a fake `#game_token` and mocked profile API asserting the nickname chip and bearer header. Any console error or warning, or page error, fails the run.

## 14. Testing and acceptance criteria

`npm test` (`tests/run-tests.js`, 46 tests, ~2 s) covers: every legal pour shape (empty, matching, contiguous run, partial), every invalid reason, scoring components and tie order, terminal states, serialization round-trip and version rejection, replay hash determinism, idempotent duplicate ids, 500-command malformed fuzz, 100-seed deal fuzz (2–12 colours), golden easy/medium/hard/interrupted/move-limit/undo/noUndo sessions, `validateContent` over all 40 stages, 6 challenges and 7 dailies, lesson legality in order, daily determinism, `legalPours` pointless filter, hint legality, `checkTimeout`, storage reset, platform profile resolution, and the graphics model (GPU detection, resolve with presets/overrides/scale clamp, preset clears overrides, cost summary, locale coverage).

`node tests/server-regression.mjs` (with `CP_DATA_DIR` and `PORT`) probes honest and forged score submissions, telemetry, achievements and malformed URLs. `npm run test:e2e` is the browser playthrough in §13.

QA bar, as checkable statements:
1. Every mode card, setup screen, HUD button, pause option, results action, help card and settings control is reachable and functional with mouse, touch and keyboard.
2. No console errors or warnings during boot, a full round, pause/resume, settings changes, or results, with and without WebGL.
3. At 1280×800, 390×844 portrait and 844×390 landscape nothing is clipped: the vessel row wraps, the tray stays above the home indicator, the countdown and pause dialog are centred and complete.
4. A first-time player sees "Begin with a lesson" and lesson cards explain each mechanic before the journey.
5. A ranked completion offline still records a local best and shows the results screen; hosted, an accepted submission shows its rank.
6. `node --check` passes on every module; `npm test` and the e2e pass.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-art.webp` (1280×720, 39 KB) | Title-screen key art above the wordmark | FLUX.2 klein, seed 8801, 1536×864, 28 steps | Generated in this pass, wired (`ui.js buildTitleScreen`, hides on load error) |
| `assets/results-harmonized.webp` (960×540, 22 KB) | Results illustration for a completed round | FLUX.2 klein, seed 8802, 1024×576 | Generated in this pass, wired (`ui.js renderResults`) |
| `assets/results-resists.webp` (960×540, 27 KB) | Results illustration for a failed round | FLUX.2 klein, seed 8803, 1024×576 | Generated in this pass, wired |
| `coverart.png` (1200×675, 306 KB) | Launcher cover (`starhermit.txt cover=`) | Key art (seed 8801) + ffmpeg drawtext title/tagline, 256-colour PNG | Replaced in this pass (previous file was a generic template) |
| `icon.png` (256×256), `favicon.svg` | Launcher icon, tab icon | Authored SVG | Shipped |
| `sfx/select.opus` … `sfx/tick.opus` (12 clips) | Core foley (§9) | MOSS-SoundEffect v2.0, 100 steps | Shipped |
| `sfx/achievement.opus`, `sfx/time-warning.opus`, `sfx/new-best.opus` | Achievement, time warning, personal best (§9) | MOSS-SoundEffect v2.0, 100 steps | Generated in this pass, wired with synth fallbacks |
| `sfx/manifest.txt` | Canonical clip → event → description → context list | Hand-written from §9 | Created in this pass |
| `sfx/manifest.json`, `sfx/manifest.md` | Generator input / generated summary | `tools/generate_sfx_from_manifests.py` | Updated |
| 3D models / character animation | — | — | Not called for: the scene is procedural geometry and there is no character |

## 16. Known limitations

- English only; no locale switch (§10).
- The `friends` leaderboard scope returns the global list; filtering depends on the host.
- A failed ranked submission shows "Ranked submission is queued for when the host responds", but nothing is retried later; the replay is only archived locally.
- The Voice slider drives an empty bus; the Haptics toggle is disabled (no vibration is used).
- Boards above 6 colours use best-first search, so par is near-optimal rather than exact, and `hint` may return a non-optimal move when the 60 000-node budget runs out.
- The solver's `stateKey` collapses vessel permutations (sound for existence, unverified for optimality) and `createGame` could in theory exhaust its retries (never observed in fuzzing) — see `knownissues.md`.
- Score chase "Global daily" uses the client's UTC date from `serverNow()`; if the host clock is unreachable, the date is the device's.
- Progress lives in localStorage; clearing site data loses it unless exported.
- Audio and the WebGL scene are not covered by automated tests (headless Chrome has no audio device; the scene is only checked to boot cleanly).

## 17. Design intent not yet implemented

- Localization into the nine required locales with a string table and a language selector (strings would move out of `ui.js`, `rules.js`, `content.js`).
- Queued retry of ranked submissions from the local replay archive when the host comes back.
- Client-side friends filtering once the host exposes a friends list to game-scoped tokens.
- A "while you were away" summary for hosted resume (today: toast with time away; the local clock is paused, nothing is fetched).
- Vibration on invalid/complete when the platform exposes haptics.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.
