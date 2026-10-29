# Chromatic Pour

An alchemist's liquid-sorting puzzle: pour colored liquids between vessels
until every vessel holds a single uniform color. Fully deterministic rules
engine, seeded daily boards, score-chase leaderboards.

It is a StarHermit engine script game (engine 1.23.0): TypeScript in
`native/` on the runtime's host API, played natively by the StarHermit client
and in browsers through the engine's web runtime, which `index.html` (the
loader `npm run package` writes) pins on wiki.starhermit.com. The hand-written
browser client was removed; it can be recovered from history.

## Run

```
starhermit .                 # the runtime, from a StarHermit engine release
npm run package              # after every change: rewrites index.html + starhermit-files.json
```

`STARHERMIT` names the runtime for the npm scripts (default: the published
Linux runtime under `~/sh/runtime`). `node server.js` is a local dev server
with its own score API, probed by `npm run test:server`; the game does not
call it.

## Controls

- **Pointer / touch**: tap or click a vessel to lift it, tap a target to pour.
- **Keyboard**: Arrows/WASD move focus, Enter/Space select and pour, Esc
  cancel/pause, P pause, U undo, H hint, R restart, C recenter.
- **Gamepad**: D-pad/left stick focus, A pour, B cancel, Start pause,
  X undo, Y hint, Select restart.

All are rebindable in the runtime's Options (F1).

## Modes

Journey (40 stages with mastery gates), Daily (one seeded board per UTC day,
global leaderboard), Challenges (move/time limits), Practice (four
difficulties), Score chase, and five guided lessons.

## Tests

```
npm test              # rules, i18n, migration, then the engine checks and play scripts
npm run test:browser  # the packaged loader in headless Chrome (desktop, phone, landscape)
```

## Architecture

- `js/rng.js`, `js/rules.js`, `js/content.js`, `js/session.js`,
  `js/storage.js` — the deterministic rules, content, session and store,
  shared by the client, the tests and `server.js`.
- `js/migrate.js` — the engine save document and what carries over from the
  browser build's cloud save and settings.
- `native/` — the engine client: state machine and input (`main.ts`),
  screens (`screens.ts`, `style.ts`), the vessel board (`board.ts`,
  `shapes.ts`), the 3D shelf (`render.ts`, `quality.ts`), sound
  (`audio.ts`), platform and saves (`platform.ts`), strings (`i18n.ts`).
- `score-script.js` — the platform script that posts ranked totals.

See `spec.md` for the full running specification.
