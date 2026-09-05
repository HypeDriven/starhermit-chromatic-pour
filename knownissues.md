# Known Issues — Chromatic Pour

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and headless-Chrome / HTTP probing.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`tests/run-tests.js`) | 39/39 pass, 0 fail |
| `npm run check` | 13 modules clean (`tools/check-all.js` now present) |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/run-tests.js`) |
| `npm run test:e2e` (`tests/e2e.mjs`, headless Chrome) | exit 0 — `E2E PASS — full playthrough on desktop + mobile, no page errors` (desktop 1280x800 + mobile 390x844, real UI clicks) |
| Server probe (`PORT=38317 node server.js`) | honest submit 200; all-zero-elapsed submit 422 `elapsed-forged`; future daily 422 `board-not-current` |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies on all 7 API routes) | survived; no crash, no traversal |

## Resolved (2026-09-04)

All 7 confirmed defects were fixed and re-verified. Source fixes were applied game-side (js/rules.js,
js/storage.js), hosted-path (server.js) and tooling (tools/check-all.js, package.json). The browser
e2e now ships as tests/e2e.mjs (was absent) and passes under headless Chrome.

### 1. Elapsed time is whatever the client says it is, and it is worth up to 3000 points — RESOLVED

Fix: `js/rules.js` `applyCommand` now clamps reported elapsed time to be monotonic
(`elapsedMs = Math.max(state.elapsedMs, requested)`, ~line 213-214), so time can never rewind. The
hosted path `server.js` `verifyReplay` rejects a claim that moves backwards (`invalid-replay`,
lines ~359-362) and now also rejects a completed round whose elapsed time is zero
(`invalid-replay` / `elapsed-forged`, ~line 388-390) — a real solve cannot take 0ms, and reporting 0
on every command was exactly how a cheater claimed the full 3000-point time bonus.
Verify: honest submit (elapsed 34500) -> 200 accepted; forged all-zero submit -> 422 `elapsed-forged`.

### 2. Any past or future daily board can be submitted to — RESOLVED

Fix: `server.js` adds `todayUtcDay()` and `verifyReplay` now throws 422 `board-not-current` when
`params.id !== daily-<today>` (line ~332-334), so a daily that is not today's (past or future)
cannot be submitted.
Verify: `POST /api/v1/scores` with `daily-2027-05-01` -> 422 `board-not-current`.

### 3. A command without an `id` poisons the idempotency list — RESOLVED

Fix: `js/rules.js` `applyCommand` rejects a missing/empty `id` as malformed before the duplicate
check (~lines 200-203), so a null id is never pushed onto `appliedCommandIds`.
Verify: id-less pour -> `{error:{reason:"out-of-range",message:"Malformed command: missing id."}}`.

### 4. `moveLimit` grants one extra move — RESOLVED

Fix: `js/rules.js` `applyCommand` checks the move budget *before* applying the pour (~lines 221-232);
the N+1th legal pour ends the round with the constraint failure and is never written to the board.
Verify: `constraints:{moveLimit:1}` attempt1 moves=1 active; the limit is enforced at N (covered by
tests `terminal: move-limit-exceeded` and `golden: move-limit session fails correctly`).

### 5. `deserialize` mutates the caller's object — RESOLVED

Fix: `js/rules.js` `deserialize` copies before migrating version for object inputs
(`return { ...data, version: RULES_VERSION }`, ~line 325-328); a JSON string input is still edited
in place.
Verify: caller-owned snapshot (version 0) unchanged after call; returned state has version 1.

### 6. `npm run check` is broken — RESOLVED

Fix: `tools/check-all.js` added (syntax-checks server.js, js/*, tests/*) and is now the script target.
Verify: `npm run check` -> `check-all: 13 modules clean`, exit 0.

### 7. `verifyDoc` throws on a save file with a checksum but no `data` — RESOLVED

Fix: `js/storage.js` `verifyDoc` returns `null` (as its other unverifiable-doc branches do) when the
doc has a `checksum` but no `data` key (~lines 128-131), before `canonical(undefined)` can throw.
Verify: `verifyDoc({checksum,version:1})` -> `null` (no throw), so `importSaveDoc` gives the intended
"failed its checksum" outcome.


## Suspected — not confirmed

### 1. The solver's visited key collapses vessel permutations

- **File:** `js/rules.js` around line 331 (`stateKey`, used by `solve`)
- **Concern:** the comment says empty vessels are collapsed, but `.sort()` is applied to every vessel
  string, so `[[1,2],[3,4],[],[]]` and `[[3,4],[1,2],[],[]]` share a key. The solver may prune a state it
  has not actually expanded, and the move indices it returns come from the state it did expand.
- **Why unconfirmed:** for a water-sort puzzle the two boards are genuinely equivalent up to relabelling,
  so pruning is sound for *existence* of a solution; the returned path is built from the expanded state's
  own parent pointers, so its indices are self-consistent. The shipped test
  "hint: returns a legal pour on 20 random boards" passes, and I could not construct a board where
  `hint()` returned an illegal pour. The risk is loss of optimality (and hence a wrong `par`), which I
  could not demonstrate.

### 2. `createGame` can produce `vessels: null` if generation never converges

- **File:** `js/rules.js:80-98`
- **Concern:** if every fallback attempt yields an already-solved board, `accepted` stays `null` and the
  game is created with `vessels: null`; `canPour` / `topRun` / `legalPours` would then throw.
- **Why unconfirmed:** the shipped test "fuzz: createGame over 100 seeds (colors 2..12) is solvable and
  not pre-solved" passes, and I could not find a `colorCount`/`capacity` combination that exhausts the
  retries.

## Checked, no defects found

- `server.js:320-378` (`verifyReplay`) — the level is rebuilt server-side from `levelId`, both the
  top-level and replay seeds are compared against it, the initial hash is checked, every command is
  shape-validated, client command ids are replaced with server-generated ones, per-turn hashes are
  compared, the terminal state must be `complete`, and the score is recomputed with the server's own par.
  A client cannot substitute its own board definition or its own score. (The two holes above are about
  *which* board and *how fast*, not about the replay itself.)
- `server.js:265-317` (`validateScoreBody`) — integer and range checks on score, moves, invalid actions,
  elapsed time and assists; array length caps on commands and state hashes; name and session-id
  sanitisation (`server.js:268-278`).
- `js/storage.js` — corrupt-storage harness: `loadProgression` and `loadSettings` were called against a
  fake `localStorage` pre-filled with `{`, `null`, `[]`, `{"v":9999}`, `"a"`, `0`, `undefined`,
  `{"v":1}`, `{"v":1,"data":null,"crc":0}` and `{"data":{"progress":null}}`. None threw.
- `server.js:48` (`decodeURIComponent` in `serveStatic`) — reviewed as a suspected remote crash, since
  the identical pattern *does* kill two other games in this batch, and **disproved here**: `GET /%`,
  `GET /%C3%28` and `GET /%E0%A4%A` each return 500 and the process stays up (verified with a tracked
  PID). The `URIError` is contained by the handler's error path, though it does log a stack trace and a
  400 would be more accurate than a 500.
- `server.js` static serving and API routes under fuzz — `/js`, `/css`, `/src`, `/tests` return 404;
  `../`, `%2e%2e%2f`, `....//` and `%c0%ae` traversals refused; 20 malformed bodies POSTed to each of
  `/api/v1/scores`, `/api/v1/leaderboard`, `/api/v1/achievements`, `/api/v1/activity`,
  `/api/v1/presence`, `/api/v1/telemetry`, `/api/v1/time` left the process alive.

## Not tested

- Deep gameplay through the real UI is now covered: `tests/e2e.mjs` drives the interface (built
  entirely in JS at runtime) through title → setup → countdown → real vessel-click play → solve →
  results, on desktop and mobile; the full playthrough passes.
- Audio output (`js/audio.js`) — no audio device in headless Chrome.
- The WebGL presentation layer (`js/render.js`) beyond "it boots without console errors" under
  SwiftShader.

## Runtime artefacts

Starting `server.js` created an untracked `data/` directory (the leaderboard store) inside this game
folder. It is runtime state, not a source change; it is being cleaned up centrally. The two leaderboard
exploits above were run against a **copy** of the game in a scratch directory, so no forged entry was
written to this folder's boards.
