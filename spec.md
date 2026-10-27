# Chromatic Pour — Game Design Document (running spec)

**Pitch:** Pour glowing layers of liquid between glass vessels on an alchemist's shelf until every vessel holds a single colour, in as few pours as you can.
**Genre:** Sorting puzzle (water-sort family) with seeded daily competition. **Players:** 1; asynchronous global/friends score comparison. **Round length:** 1–5 minutes (3 colours ≈ 1 min, 10 colours ≈ 5 min). **Session:** 5–20 minutes.
**Platforms:** A StarHermit engine script game (engine 1.18.0, host API 1.20): natively in the StarHermit client, and in desktop and mobile browsers through the engine's web runtime; portrait and landscape. **Rendering:** the vessel board is drawn `starhermit:ui` widgets (the playable surface, as the browser build's DOM board was); a `starhermit:scene` shelf draws the environment, lighting and celebrations behind it.

This document describes the game as it runs today (present tense). Anything not yet implemented is listed only in §17.

## 1. File map

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: `name=Chromatic Pour`, `launch=index.html`, `engine.entry=native/main.ts`, `engine.version=1.18.0`, `engine.minor=17`, `engine.capabilities=platform,storage,clipboard`, `server=score-script.js`, `cover=cover.jpg`, eleven `control.*` actions with `engine.gamepad.*` defaults and two `engine.group.*` headings. |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand. |
| `native/main.ts` | Entry: the state machine, selection and pour intents with sounds and announcements, the pour lock and Skip, undo, hints, restart, lessons, timed challenges, outcomes, input actions, lifecycle. |
| `native/screens.ts`, `native/style.ts` | Every screen, HUD, rail, tray, dialog and toast on `starhermit:ui`; styles from `assets/ui-style.json` (converted from `tools/ui-style.css` by `npm run css`) plus per-theme and palette tokens. |
| `native/board.ts`, `native/shapes.ts` | The vessel board as focusable widgets (labels, lift, pour animation, refusal shake, hint pulse) and the ten layer badges drawn as shapes. |
| `native/render.ts`, `native/quality.ts` | The shelf on `starhermit:scene` (§8) and the four graphics presets keyed by the runtime's quality level. |
| `native/audio.ts` | Clips, the rendered music and ambience, on the runtime's buses (§9). |
| `native/platform.ts`, `js/migrate.js` | Saves, settings, migration from the browser build, profile, invite, leaderboard, server clock (§12). |
| `native/i18n.ts`, `js/i18n.js`, `js/strings.js`, `js/platform-strings.js` | Localization (§10). |
| `js/rules.js` | Pure rules engine: deal, legality, pour, scoring, hashing, solver, hint. No DOM, Date, or Math.random. |
| `js/content.js` | Colour sets, themes, difficulties, lessons, 40 journey stages, 6 challenges, daily/practice generators, par + content validation. |
| `js/session.js` | `GameSession`: clock, selection state machine, undo history, command log, replay envelope, snapshot/restore. |
| `js/storage.js` | Settings, progression, bests and replays through `localStorage` (on the engine a shim over the save and device store), checksummed save export/import, achievements. |
| `js/rng.js` | xmur3 + mulberry32 seeded streams: `rulesStream`, `decorStream`, `audioStream`. |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished ranked round's total and posts it to the `high-score` leaderboard. |
| `server.js` | Local dev server (not packaged): static files + its own `/api/v1` (replay-verified scores, leaderboard, achievements, telemetry, presence), probed by `tests/server-regression.mjs`. |
| `assets/` | Key art and results illustrations, `ui-style.json`. |
| `sfx/` | 15 Opus clips; `manifest.txt` (canonical), `manifest.json` (event table), `manifest.md` (generated). |
| `tests/` | `run-tests.js` (rules, content, session, storage), `i18n.test.mjs`, `migrate.test.mjs`, `native.mjs` with `native/*.play`, `server-regression.mjs` (§14). |
| `tools/` | `package-web.mjs`, `css.mjs` + `ui-style.css`, `gen-play.mjs` (solver-driven play scripts), `browser-play.mjs`, `check-all.js`. Not packaged. |
| `cover.jpg`, `coverart.png`, `icon.png` | Store/launcher art. |
| `CONTRACTS.md`, `knownissues.md`, `LICENSE.md` | Module contracts, QA ledger, PolyForm Noncommercial 1.0.0. |

## 2. Vision and design pillars

Chromatic Pour is the water-sort puzzle reframed as an alchemist's evening ritual: patient, warm, and exact. The fantasy is a shelf of glass that you tidy into harmony, not a timer you race.

1. **The shelf is honest.** Every legal move is computable and shown: a lifted vessel highlights every legal target, a refused pour says why in words, the hint comes from the same solver that proved the level solvable. Rules in: solver-backed hints, explicit refusal messages, seeds shown and shareable. Rules out: hidden state, luck, boards that cannot be finished.
2. **One pour, one answer.** Each tap or key gets an immediate visual and audible reply (lift, clink, glug, thunk) and the round clock only runs while you can act. Rules in: input acknowledged in the same frame, animation skippable, undo free. Rules out: long unskippable choreography, penalties for thinking.
3. **Colour is never alone.** Ten shape badges, five palettes (standard + three colour-vision sets + high contrast), text labels on layers, and full ARIA vessel descriptions mean the puzzle is solvable without seeing hue. Rules in: badges on every layer, palette switch mid-round. Rules out: any mechanic that only reads through colour.
4. **Same recipe for everyone.** Boards are pure functions of a seed; the daily is one seed per UTC day; ranked scores are re-simulated from the command log on the server. Rules in: deterministic deal, replay envelopes, server-owned clock. Rules out: client-trusted scores, unverifiable boards.
5. **Glow that gets out of the way.** The 3D shelf, particles and music are ambience around the board, degrade by tier, and calm under reduced motion. Rules in: environment-only scene, a widget board that carries every fact. Rules out: gameplay information that lives only in the 3D scene.

## 3. Player experience

**Target player:** someone who enjoys short, tidy logic puzzles (water sort, Ball Sort, Sudoku-adjacent), plays in 3–10 minute pockets on a phone or during a break on desktop, and likes a daily to compare with friends.

**First 60 seconds.** A new player's Play button reads "Begin with a lesson" (`tutorialDone` false; `playSubLabel`). Pressing it opens the Learn setup with five lessons; the first, *The First Decant*, puts a 2-colour, 4-vessel shelf on screen with an instruction card ("Vessels hold layers of liquid, bottom to top. Lift one by selecting it — select the first vessel."). Each step requires the player to perform the action; a wrong vessel shakes, plays the wooden thunk and toasts the step's hint text. Steps advance with the crystal chime. Lesson 2 deliberately asks for an illegal pour so the player reads the refusal. Completing any lesson sets `tutorialDone`, and Play then continues the Journey. Players who skip lessons still meet only 3-colour stages first, and the Help screen shows four rule cards drawn with live mini-vessels plus the current key bindings.

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

All modes share the rules above; they differ in content, constraints and ranking (`native/screens.ts`, `content.js`).

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
| Lift / pour | Click vessel; `Enter`/`Space` on focused vessel | Tap vessel (or press-and-hold 320 ms with "Hold to confirm") | South (A) on focused vessel |
| Move focus | `←`/`→`, `A`/`D`; `↑`/`↓`, `W`/`S` (by row) | — | D-pad / left stick |
| Cancel selection, else pause | `Esc` | Tap the lifted vessel again | East (B) |
| Pause / resume | `P` | Tray "Pause" | Start |
| Undo | `U` | Tray "Undo" | West (X) |
| Hint | `H` | Tray "Hint" | North (Y) |
| Restart | `R` | Tray "Restart" | Select |
| Recenter view | `C` | — | Right stick press |
| Skip pour animation | Click "Skip animation" | Tap "Skip animation" | — |
| Drawers (701–1023 px) | ☰ objective / ⚗ actions buttons in the top bar | same | — |

Every action is a `control.*` action in `starhermit.txt`, rebindable (keys and gamepad buttons) in the runtime's Options (F1) › Controls, where the bindings sync with the player's account; the Help table shows the effective keys (`bindingLabel`). Lessons have no pause (as before): Pause is unavailable while a lesson runs. A press that reaches a vessel both as its widget and as the confirm action counts once.

**Input locking.** `inputLocked` is true from a pour until it settles: 560 ms with motion, 0 ms under reduced motion; the "Skip animation" button appears during the lock and settles everything instantly (`skipPour`, plus `renderer.skip()`). Undo/hint/restart and vessel taps are ignored while locked; the undo button is disabled visually. Typing in the seed field holds back game actions (engine.minor 17).

**Feedback per input.** Lift: vessel rises with a glow ring, legal targets get the `target-ok` outline, clip `select`, live-region text "Vessel 3 selected, Malachite, 2 layers." Pour: source `lifting`, destination `receiving`, new layers animate in with 70 ms stagger, `pour-start` then `pour-end`; a vessel that becomes full and uniform chimes `layer-complete`. Refusal: shake (or a red ring under reduced motion), `invalid`, assertive announcement of the reason. Hint: source/target pulse for 2.4 s, `hint`. Undo: `undo` + "Last pour undone." Countdown: `tick` on 3-2-1, `ui` on Go.

## 7. Screens and UI flow

**App state machine (`native/main.ts`).** `boot → title ⇄ profile-ready → mode-select → preparing → tutorial | countdown → active ⇄ paused → resolving → results → progression`, with `title`, `mode-select` and `preparing` reachable from results/progression, and `title` from any in-round state via "Leave to title".

**Screens (`native/screens.ts`):** *title* (wordmark over key art, Play with contextual sub-label, Daily and Journey cards, Practice/Challenge/Score chase buttons, Help/Settings/Progress/All modes), *modes* (six cards with ranked badge, duration, assists), *setup* (per-mode: stage grid, difficulty + seed, challenge list, daily panel with par, score-chase board picker + table, lesson list), *play* (left rail: objective, "Harmonized n of m vessels", limit badge, level name; playfield: canvas host + board; right rail: Undo/Hint/Restart/Pause, timer, move count; bottom tray on mobile), *results* (headline, outcome illustration, stars, score table, stats, assists, achievements, ranked note, best delta, Replay / Next / Change mode / View progress), *help* (four rule cards with mini boards, bindings table, lesson launcher), *settings* (Audio, Graphics, Controls, Accessibility, Gameplay, Data), *progression*. Every screen switch scrolls back to the top. The title's mode cards share one row on wide windows and the key art is capped in height, so the title fits 1440×900 without scrolling.

**Overlays:** countdown (3-2-1-Go, 700 ms steps; "Go" only under reduced motion), tutorial card (lesson title, step n of m, instruction), pause dialog (focus trapped, `Esc` resumes: Resume / Restart / Settings / Help / Leave to title), confirm dialog (used for import and double-confirmed reset), "Settling the shelf…" note during `resolving`, toasts (max 4, 4.2 s; achievements unlocked at round end are not toasted — the results screen lists them under "Achievements unlocked" and they are announced to screen readers, so no toast lands on the results), dismissible error banner (8 s auto-hide).

**Layouts (`native/screens.ts`, from the window's size in logical pixels).**
- ≥ 1024 wide: objective rail | playfield | actions rail; tray hidden.
- 701–1023 wide: single column; the rails open as drawers from the ☰ objective / ⚗ actions buttons in the top bar.
- ≤ 700 wide (portrait phone): rails hidden; the status line (unified count, moves, clock) under the top bar; bottom tray with Undo / Hint / Restart / Pause (reversed for left-handed); the lesson card above the tray.
- Landscape ≤ 500 tall: the objective rail as a narrow column, the actions rail hidden, the tray present; on the title the key art shrinks so Play sits above the fold.
- Safe areas and the player's UI scale and text size come from the runtime; the board and shelf follow the playfield rectangle.

**Must never be cut off:** the full vessel row (wraps to multiple rows via the board's flex layout), the tray buttons, the timer/limit badge, the countdown, the results action row, and the pause dialog's Resume button.

## 8. Art direction

**Palette (base tokens, `tools/ui-style.css` → `assets/ui-style.json`):** background `#14100e` → `#1c1611`; ink `#ece2cf`, dim ink `#b3a488`; default accent `#e8a33d` (overridden per theme); danger `#e05d4f`; ok `#8fce6e`; focus ring `#ffd97a`; panels `rgba(41,32,25,.66)` with `rgba(236,226,207,.16)` borders and blur. High contrast (the runtime's) swaps panels to solid `#1d1712`, dim ink to `#d5c8ab`, borders to 55 % ink, and removes blur.

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

**Motion.** Lift (rise + glow), receiving pulse, staggered layer arrival, invalid shake, wordmark glow (4.5 s), countdown pop; 3D: camera spring framing, drifting embers/motes, celebration bursts, brief fail shake. Under reduced motion (the runtime's setting, which follows the system's) UI animation stops, refusals show a static red ring, the countdown is just "Go", pour lock is 0 ms, and the renderer cancels swoops, shakes and bursts while keeping event timing.

**3D environment (`native/render.ts`).** The shelf on `starhermit:scene`: ACES tone mapping at exposure 1.1, a warm or cool hemisphere fill per theme, one shadow-casting key light fitted to the shelves and wall, a rim light, the flickering candle's point light, theme fog. Procedural wood, wall and flame textures come from `decorStream`; decor (books, candle on a brass dish, scrolls, potted sprig, two stoppered specimen flasks with glowing draughts, six bobbing orbs in the theme's accent) casts and receives shadows; dust motes drift in the candle light. A completed shelf sends bursts of the palette's colours across the shelf with a slight camera ease in; a failed one dims the lights. The camera (35°, 18° pitch, fitted to a seven-vessel row, wider with Wide camera) frames the shelf into the playfield rectangle the HUD leaves (`setViewOffset`); a drag on the playfield outside the vessels pans it a little, sprung back by Recenter (C).

**Graphics.** The runtime's Options › Graphics chooses the level (Auto from the device, or a level), the render scale, adaptive resolution and the frame-rate limit; the game maps the level's tier to the browser build's four presets (`native/quality.ts`): environment materials (Lambert on Low, standard PBR on Balanced, physical clearcoat brass and wax on High/Ultra), wood and stone texture sizes, round-prop segments, and the counts of motes and celebration particles (scaled within the tier by the level). Shadows, ambient occlusion, bloom (candle flame, orbs, draughts), the colour grade with vignette, anti-aliasing and the room-environment reflections follow the level through the runtime's post effects. The detail tier adds the laid-stone wall with relief, brass trim and corbels, and on the board the cylinder shading of each liquid band, the top layer's meniscus, the glass gloss streak and lip and a slow caustic sweep. The specimen flasks are clear glass at every level (the engine draws no transmission).

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Environment materials | Lambert | Standard | Physical (clearcoat brass, wax) | same as High |
| Shelf wood / stone wall texture | 128² / 256×128 | 256² / 256×128 | 512² / 512×256 | 512² / 1024×512 |
| Round-prop segments | ×0.5 (min 6) | ×0.75 | ×1 | ×1.5 |
| Motes / celebration particles at the tier's floor | 0 / 60 | 24 / 160 | 40 / 300 | 60 / 500 |

**Visual assets the design calls for:** title key art (shelf of banded vials over coals), a "harmonized" results illustration (uniform vessels with rising motes), an "unfinished" results illustration (jumbled vessels, hourglass, cooled coals), and a 16:9 cover reusing the key art. All four are shipped (§15).

## 9. Audio direction

**Mix philosophy.** Small glass-and-wood foley in front, a sparse generative melody behind, room tone under everything. Nothing is loud; the win motif is the only flourish. The runtime's buses carry it: music → `music`, effects and ambience → `effects`, the interface tick → `interface`; the old default levels (music 70 %, effects 90 %, ambience 50 %) are folded into each sound's gain. Volumes, mute and the simultaneous-voice limit are the runtime's Options › Audio. In browsers sound starts after the first press.

**Music.** A generative loop in A-minor pentatonic (220–440 Hz motif pool) at 0.5 s steps: a note every other step with 25 % rests; a fifth-above harmony layer fades in once `intensity ≥ 0.35` and a low pulse joins at `≥ 0.7`, where intensity = harmonized vessels ÷ total vessels (`setMusicIntensity`). Melody choices come from the seeded `audioStream`, so a replay sounds the same.

**Ambience.** One of five families (warm, cool, tidal, verdant, gilded: two detuned drones + LFO + low-passed noise) chosen from the theme id; starts when a round goes active, cross-fades on theme change, stops on results/title.

**Samples.** `native/audio.ts` reads `sfx/manifest.json`, maps each `event` to its clip and loads the clips one at a time once the mixer runs; the music notes and ambience loop (oscillators and filtered noise in the browser build) are rendered once into clips with the same envelopes. A cue whose clip has not loaded yet is silent (its caption and announcement still show). Each play gets a seeded ±4 % pitch variant.

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

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Strings.** English source strings are the keys; `js/strings.js` holds the tables (es-419, de-DE, fr-FR, pt-BR, it-IT in full; en-GB is derived with British spelling — colour, harmonised, recentre; es-ES and fr-CA list only their differences, e.g. fr-CA *pointage*). Everything a player reads goes through `tr()`/`N()` (`native/i18n.ts` over `CPI18N.T()`): every screen, HUD, dialog, result, help text, setting, toast and announcement, lesson text and hints, theme, difficulty, challenge and achievement names, rule refusals; platform lines come from `js/platform-strings.js`. `tests/i18n.test.mjs` checks every key used in `native/*.ts` and the content is translated in every locale with its placeholders, and that no row is unused.
- **Language.** The runtime's interface language (Options › Language, following the account's preference) picks the locale, mapped to the nearest shipped one (es-MX → es-419, en-AU → en-GB, fr → fr-FR, others → en-US); numbers and dates use `Intl` in that locale.
- **Live switching.** Strings are looked up every frame, so a language change shows at once; the round, timer, selection and renderer are untouched.
- **Expansion.** Buttons wrap their labels, card grids reflow, rails scroll, and the four-up phone tray fits the longest label (de-DE "Rückgängig") at 390 wide.

## 11. Accessibility

- **Keyboard and gamepad:** every screen is reachable by Tab/Enter and the gamepad (the runtime's menu navigation); on the board, arrows/WASD or the D-pad move between vessels, Enter/Space or South pours, `Esc`/East cancels or pauses; dialogs trap focus and restore it on close; the focus ring is the theme's gold outline.
- **Screen reader:** the runtime publishes the UI to screen readers; each vessel is a button labelled "Vessel 3: 2 layers, top Malachite, single color"; selections, pours, hints, undo, countdown, refusals and results are announced (`ui.announce`).
- **Colour independence:** a shape badge on every layer, optional text labels ("Labels on liquids"), four alternative palettes plus a contrast palette.
- **Motion, contrast, text size:** the runtime's reduced motion, high contrast, UI scale and text size settings (Options › Accessibility) apply; reduced motion keeps the §8 behaviour.
- **Targets:** buttons at least 44 px, the left-handed tray order.
- **Audio never required:** every cue has on-screen text and an optional caption.
- **Assists:** hold-to-confirm (320 ms), hints toggle, lesson replay from Help, rebindable controls.

## 12. StarHermit integration

Conventions per https://wiki.starhermit.com/. All platform access is the runtime's `starhermit:platform` and `starhermit:storage` (`native/platform.ts`); the game never sees a token.

| Feature | Used | How |
|---|---|---|
| Sign in / profile | Yes | Signed out, the guest chip ("Guest — sign in") and **Sign in with StarHermit** call `requestSignIn()`; signed in, the chip shows the nickname (else "Player <6 chars>") and avatar. |
| Saves | Yes | The game's save (`saves`) is `{ v: 1, progression, bests }` on the device and in the player's cloud slot; a conflict between two devices merges record by record (`js/migrate.js mergeDocs`: best stars and fewest moves/fastest time per stage, every daily and achievement, best per board). The browser build's cloud save (the SDK's checksummed `{settings, progression}` doc in `game:<slug>`) shows as foreign and is merged in and replaced once (`fromBrowserSave`). Settings › Data shows the sync state (Offline / Saving to cloud… / Cloud save synced. / Cloud sync unavailable). Export save / Import save write and read the checksummed save file through the runtime's file dialogs. |
| Settings | Yes | The game's own options (palette, theme, labels on liquids, hints, left-handed tray, hold to confirm, wide camera, lessons done, last mode) are `settings` keys synced with the account; the browser build's settings keys are read once, their game options kept, then removed. Volumes, graphics, language, accessibility and controls are the runtime's Options. |
| Controls | Yes | Eleven `control.*` actions with gamepad defaults; rebinding and sync are the runtime's (§6). |
| Invite link | Yes | Signed in, **Invite a friend** copies `inviteLink()` to the clipboard with a toast. |
| Server clock | Yes | `serverNow()` gives the daily's UTC date and countdown; offline, the device's clock. |
| Platform leaderboard | Signed in to post; everyone reads | A completed ranked round (challenge, daily, score chase) posts its total through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores }`; the script posts it to the `high-score` board, 0–100,000, higher is better), then reads the player's rank: "Leaderboard rank: #N", or "Score posted to the leaderboard." / "Score not posted to the leaderboard.". Score chase shows the board's rows (Global daily / all-time / Friends) to guests too. |
| Reports | Yes | The runtime's Options › Report a problem and its crash reports. |
| Platform achievements, sessions, matchmaking, chat, replays, realtime, voice | No | Solo ruleset; achievements are kept in the save. |

`server.js`'s own API (replay-validated scores, boards, telemetry, achievements, activity, presence) is the local dev server's and is never called by the game.

## 13. Technical architecture

- **Modules.** `js/rules`, `rng`, `content`, `session`, `storage` and `migrate` are ES modules shared by the engine client, the tests and `server.js`; `js/strings.js` and `js/i18n.js` are classic scripts (`loadClassic`). `native/*.ts` is the client on the host API (`starhermit:engine`, `ui`, `draw`, `scene`, `audio`, `input`, `platform`, `storage`).
- **State ownership.** Rules state is immutable and only changes through `applyCommand`; `GameSession` owns clock, undo stack, command log and hashes; `native/main.ts` owns the screen state machine and sends intents; `screens.ts`/`board.ts` draw snapshots each frame. The round clock runs on the runtime's fixed steps, so play scripts replay exactly.
- **Determinism and replay.** Envelope: `{schemaVersion, build, contentVersion, levelId, seed, initialHash, startedAt, commands[], stateHashes[], terminal}`. `GameSession.snapshot()/restore()` serialise a round for resume.
- **Persistence.** `js/storage.js` keeps its `localStorage` keys (`chromatic-pour:settings|progression|bests|replays`); on the engine `localStorage` is a shim whose progression and bests keys are the save and whose other keys are the device store.
- **Performance.** The shelf's detail, shadows, post effects and particle budgets follow the runtime's graphics level (`native/quality.ts`); the frame-rate limit and render scale are the runtime's; the board redraws from the session each frame (≤ 12 vessels × 4 slots).

## 14. Testing and acceptance criteria

`npm test` runs `tests/run-tests.js` (43 tests: every legal pour shape, every invalid reason, scoring and tie order, terminal states, serialization and version rejection, replay hash determinism, idempotent ids, malformed-command and deal fuzz, golden sessions, `validateContent` over all stages, challenges and dailies, lessons, daily determinism, storage and the cloud-save merge), `tests/i18n.test.mjs`, `tests/migrate.test.mjs` (save document, merge, browser-save migration, export/import), `tools/check-all.js`, then `tests/native.mjs`: the web index is current, `tsc` is clean, `starhermit check .` passes with no warning, and every `tests/native/*.play` script drives the real UI in a signed-out offscreen run:

- `learn-lesson.play` — lesson 1 by keyboard to "Lesson complete".
- `journey-stage.play` — Journey stage 1 solved by clicking vessels in the rules solver's order (`npm run plan -- 1`), three stars and the First Pour achievement.
- `practice-tools.play` — Practice: hint, a pour and its undo, a lift cancelled by Escape, pause, Restart round, the goal sheet, Leave to title.
- `screens.play` — Challenges, Score chase and its tabs, today's Daily, Settings and Help from the pause card.

`npm run test:browser` (`tools/browser-play.mjs`) plays the packaged loader in headless Chrome at 1366×768, 390×844 and 844×390 (keyboard lesson play, a hint, taps on the shelf) and fails on any console error or warning; `node tests/server-regression.mjs` probes the dev server's API.

QA bar, as checkable statements:
1. Every mode card, setup screen, HUD button, pause option, results action, help card and settings control is reachable and works with mouse, touch, keyboard and gamepad.
2. No console errors or warnings during boot, a full round, pause/resume, settings changes or results, natively and in browsers.
3. At 1366×768, 390×844 portrait and 844×390 landscape nothing is clipped: the vessel row wraps, the tray stays in the safe area, the countdown and pause dialog are complete.
4. A first-time player sees "Begin with a lesson" and lesson cards explain each mechanic before the journey.
5. A ranked completion offline still records a local best and shows the results screen; signed in, an accepted submission shows its rank.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-art.webp` (1280×720, 39 KB) | Title-screen key art above the wordmark | FLUX.2 klein, seed 8801, 1536×864, 28 steps | Shipped, wired (`native/screens.ts` title) |
| `assets/results-harmonized.webp` (960×540, 22 KB) | Results illustration for a completed round | FLUX.2 klein, seed 8802, 1024×576 | Shipped, wired (results) |
| `assets/results-resists.webp` (960×540, 27 KB) | Results illustration for a failed round | FLUX.2 klein, seed 8803, 1024×576 | Shipped, wired |
| `coverart.png` (1200×675, 306 KB) | Launcher cover (`starhermit.txt cover=`) | Key art (seed 8801) + ffmpeg drawtext title/tagline, 256-colour PNG | Replaced in this pass (previous file was a generic template) |
| `icon.png` (256×256) | Launcher and tab icon | Authored SVG | Shipped |
| `sfx/select.opus` … `sfx/tick.opus` (12 clips) | Core foley (§9) | MOSS-SoundEffect v2.0, 100 steps | Shipped |
| `sfx/achievement.opus`, `sfx/time-warning.opus`, `sfx/new-best.opus` | Achievement, time warning, personal best (§9) | MOSS-SoundEffect v2.0, 100 steps | Shipped, wired |
| `sfx/manifest.txt` | Canonical clip → event → description → context list | Hand-written from §9 | Created in this pass |
| `sfx/manifest.json`, `sfx/manifest.md` | Generator input / generated summary | `tools/generate_sfx_from_manifests.py` | Updated |
| 3D models / character animation | — | — | Not called for: the scene is procedural geometry and there is no character |

## 16. Known limitations

- The `friends` leaderboard scope returns the global list; filtering depends on the host.
- A failed leaderboard post shows "Score not posted to the leaderboard." and is not retried; the replay is only archived locally.
- No haptics (no vibration is used).
- Boards above 6 colours use best-first search, so par is near-optimal rather than exact, and `hint` may return a non-optimal move when the 60 000-node budget runs out.
- The solver's `stateKey` collapses vessel permutations (sound for existence, unverified for optimality) and `createGame` could in theory exhaust its retries (never observed in fuzzing) — see `knownissues.md`.
- Score chase "Global daily" uses the client's UTC date from `serverNow()`; if the host clock is unreachable, the date is the device's.
- A guest's progress from the browser build (its browser storage) does not carry over; signed-in players' cloud saves do.
- Sound cues are silent until their clip has loaded (no synthesized stand-ins).
- Audio is not covered by automated tests; the scene is checked by the render check and the browser run's screenshots only.
- The signed-in paths (cloud save migration and merge, score posting, rank) are covered by unit tests of their logic, not run against the live platform.

## 17. Design intent not yet implemented

- Queued retry of ranked submissions from the local replay archive when the host comes back.
- Client-side friends filtering once the host exposes a friends list to game-scoped tokens.
- A "while you were away" summary for hosted resume (today: toast with time away; the local clock is paused, nothing is fetched).
- Vibration on invalid/complete when the platform exposes haptics.

## Sound, graphics and the browser

The runtime provides what the browser build's page helpers did: Options › Audio (master, music, effects and interface volume, mute keeping levels, the simultaneous-voice limit), Options › Graphics (quality level, render scale, Auto or a 1–1000 FPS limit kept per device), and in browsers it keeps the context menu, long-press callout, clipboard shortcuts and text selection away from the game outside text fields.
