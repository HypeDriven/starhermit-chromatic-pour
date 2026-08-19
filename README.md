# Chromatic Pour

An alchemist's liquid-sorting puzzle for the browser: pour colored liquids
between vessels until every vessel holds a single uniform color. Fully
deterministic rules engine, seeded daily boards, score-chase leaderboards.

## Run

```
node server.js        # then open http://localhost:8080 (PORT env to change)
```

Any static file server works too — or just open `index.html` directly.
The server additionally hosts the authoritative API (score verification,
leaderboards, achievements) under `/api/v1/`.

## Controls

- **Pointer**: tap/click a vessel to lift it, tap a target to pour.
- **Keyboard**: Arrows/WASD move focus, Enter/Space select+confirm, Esc
  pause/cancel, U undo, H hint, R restart, C camera reset.
- **Gamepad**: dpad/left stick focus, A confirm, B cancel, Start pause,
  X undo, Y hint.

## Modes

Journey (40+ handcrafted levels with mastery gates), Daily (seeded board per
date, global leaderboard), Challenges (move/time limits), Practice (four
difficulties), and a guided tutorial.

## Tests

```
npm test
```

## Architecture

- `js/rng.js` — seeded deterministic RNG streams (rules/decor/audio).
- `js/rules.js` — pure rules engine: game creation, pours, solver, scoring,
  state hashing. Runs in browser and Node.
- `js/content.js` — level/theme/palette data, daily level derivation.
- `js/session.js` — session clock, undo, command log, replay envelopes.
- `js/storage.js` — localStorage persistence (settings, progression, bests).
- `js/render.js` — Three.js 3D vessel rendering and pour animations.
- `js/audio.js` — fully procedural WebAudio (no assets).
- `js/ui.js` / `js/main.js` — DOM screens, input, accessibility, boot/loop.
- `js/platform.js` — host-shell integration: server time, scores, telemetry.
- `server.js` — zero-dependency Node static server + authoritative API;
  re-simulates replay envelopes through `js/rules.js` to verify scores.

## Offline

Three.js is vendored at `vendor/three.module.js`; there are no CDN or network
dependencies. The game is fully playable offline — platform calls degrade
gracefully and leaderboards fall back to local bests.
