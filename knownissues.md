# Known Issues — Chromatic Pour

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and headless-Chrome / HTTP probing.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`tests/run-tests.js`) | 39/39 pass, 0 fail |
| `npm run check` | **FAILS** — `MODULE_NOT_FOUND`, see confirmed defect 6 |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/run-tests.js`) |
| `tests/e2e.mjs` (headless Chrome) | not present. Substituted a headless-Chrome smoke against `PORT=39306 node server.js`: boot to title, click Play → setup screen. No page errors, no console errors, no failed requests. |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies on all 7 API routes) | survived; no crash, no traversal |

## Confirmed defects

Defects 1 and 2 were reproduced against a running copy of `server.js`; 3-5 and 7 against the shipped
modules directly; 6 by running the npm script.

### 1. Elapsed time is whatever the client says it is, and it is worth up to 3000 points

- **File:** `js/rules.js:215` (`applyCommand`), scored at `js/rules.js:262`, tie-broken at
  `js/rules.js:285`, and accepted unchecked by `server.js:338-343` and `server.js:371-376`
- **Trigger:** submit an otherwise-honest replay in which every command carries `elapsedMs: 0`.
- **Behaviour:** `state.elapsedMs` is taken straight from the command
  (`Number.isFinite(cmd.elapsedMs) ? Math.max(0, Math.floor(cmd.elapsedMs)) : state.elapsedMs`) with no
  monotonicity or wall-clock cross-check. `verifyReplay` re-runs those same client numbers, so the
  "recomputed" elapsed time is the client's claim. `scoreState` pays
  `timeBonus = max(0, 3000 - floor(elapsedMs / 1000) * 10)`, and `compareResults` uses `elapsedMs` as the
  second tie-break key. The per-command validation at `server.js:341` only bounds each value to
  `0..DAY_MS`.
- **Expected:** spec.md §2 "Scoring and victory" — ties use "lower **authoritative** elapsed time"; §5
  "Determinism, replay, and security" — the server owns the clock. The server does expose
  `/api/v1/time`, but never compares it against the claim.
- **Evidence:** the same 15-move solution of `daily-2026-08-20`, submitted twice to a copy of the server:

  ```
  honest  : moves=15 elapsedMs=60000 total=18700  components={"completion":10000,"moveEfficiency":6300,"timeBonus":2400,"invalidPenalty":0}  -> 200 {"accepted":true,"rank":1}
  cheated : moves=15 elapsedMs=0     total=19300  components={"completion":10000,"moveEfficiency":6300,"timeBonus":3000,"invalidPenalty":0}  -> 200 {"accepted":true,"rank":1}

  board daily-2026-08-20:
    1. probe-0     19300  moves=15  ms=0
    2. probe-4000  18700  moves=15  ms=60000
  ```

### 2. Any past or future daily board can be submitted to

- **File:** `server.js:221-235` (`dailyParams`), used by `verifyReplay` (`server.js:321`) and
  `handleSubmitScore` (`server.js:389-400`)
- **Trigger:** `POST /api/v1/scores` with `board` / `entry.levelId` set to `daily-2027-05-01`.
- **Behaviour:** `dailyParams` accepts any syntactically valid ISO date and derives the level from it, so
  every past and future daily is generatable and solvable offline right now. Nothing in
  `handleSubmitScore` compares the claimed date to the server's current UTC day, and there is no
  submission window.
- **Expected:** spec.md §2 "Modes" — "Daily: one shared seed and ruleset per UTC day, synchronized to
  platform time"; §2 "Difficulty and content generation" — "Daily seeds are immutable after publication".
  A player should not be able to pre-solve and pre-populate a board that has not been published.
- **Evidence:**

  ```
  level=daily-2027-05-01 status=complete moves=18 elapsedMs=0 total=20650
  SUBMIT 200 {"accepted":true,"rank":1}
  GET /api/v1/leaderboard?board=daily-2027-05-01
    {"entries":[{"name":"probe-0","score":20650,"moves":18,"ms":0,"rank":1}],"online":0}
  ```

### 3. A command without an `id` poisons the idempotency list, silently dropping every later id-less move

- **File:** `js/rules.js:198-241` (`applyCommand`) — the duplicate check around line 200 and the push
  around line 239
- **Trigger:** call `applyCommand(state, { type: 'pour', from, to })` twice, with *different* `from`/`to`
  and no `id`.
- **Behaviour:** `cmd.id` is never validated. The first call finds no match, applies the pour, and pushes
  a null id onto `appliedCommandIds`. The second call's (also absent) id matches that stored entry, so it
  returns `{ duplicate: true }` and the legal pour is discarded — no error is surfaced to the caller.
- **Expected:** spec.md §5 — commands are validated for payload shape before they are applied; an absent
  command id should be rejected as malformed, the way `server.js` rejects other malformed replay fields.
- **Evidence:**

  ```
  1st id-less pour  -> {"moves":1}
  2nd id-less pour  -> {"duplicate":true,"moves":1}     <- a different, legal pour
  appliedCommandIds: [null]
  ```

### 4. `moveLimit` grants one extra move, and that move is applied to the board

- **File:** `js/rules.js:210` (the pour is applied) vs `js/rules.js:221` (the limit is checked)
- **Trigger:** a challenge/constraint level with `constraints.moveLimit: N`; play `N + 1` legal pours.
- **Behaviour:** the pour mutates the vessels first, and only afterwards does
  `state.constraints.moveLimit && state.moves + 1 > state.constraints.moveLimit` mark the session failed.
  The player therefore gets `moveLimit + 1` moves, and the final `state.moves` exceeds the declared limit.
- **Expected:** spec.md §2 "Modes" — "Challenge: constrained goals such as move limits"; a move budget of
  N should permit exactly N moves.
- **Evidence:** with `constraints: { moveLimit: 1 }`:

  ```
  attempt 1: moves=1 status=active
  attempt 2: moves=2 status=failed reason=move-limit-exceeded   <- the 2nd pour was applied first
  ```

### 5. `deserialize` mutates the caller's object when handed a parsed snapshot

- **File:** `js/rules.js` around line 297-306 (`deserialize`)
- **Trigger:** `deserialize(someObject)` where the argument is already an object rather than a JSON
  string.
- **Behaviour:** `const data = typeof json === 'string' ? JSON.parse(json) : json;` keeps the caller's
  reference, and the migration step then writes `data.version = RULES_VERSION` into it.
- **Expected:** a deserializer should not have side effects on its input; spec.md §5 requires state to be
  mutated only through validated commands.
- **Evidence:** a caller-owned snapshot object with `version` set to `0` came back with `version === 1`
  after the call (`mutated: true`).

### 6. `npm run check` is broken — the script points at a file that does not exist

- **File:** `package.json:9` (`"check": "node tools/check-all.js"`)
- **Trigger:** `npm run check`
- **Behaviour:** there is no `tools/` directory in this game at all; the run ends in
  `Error: Cannot find module .../tools/check-all.js` with `code: 'MODULE_NOT_FOUND'`.
- **Expected:** a declared npm script should run, or be removed.
- **Evidence:** `ls tools` → `No such file or directory`; `npm run check` → `MODULE_NOT_FOUND`.

### 7. `verifyDoc` throws on a save file that has a checksum but no `data`

- **File:** `js/storage.js:125-129` (`verifyDoc`), via `canonical` (line 105-110) and `fnv1a` (line 112-119)
- **Trigger:** import a save file whose JSON is `{"version":1,"checksum":"811c9dc5"}` — a `data` key is
  never required.
- **Behaviour:** `verifyDoc` guards the doc shape and the version, then calls
  `fnv1a(canonical(doc.data))`. For `undefined`, `canonical` takes the scalar branch and returns
  `JSON.stringify(undefined)`, which is the *value* `undefined`, not a string; `fnv1a` then reads
  `.length` off it and throws `TypeError`. The function's contract is to return `null` for any doc it
  cannot verify — which it does correctly for `{}`, `null` and `{version:1}`.
- **Expected:** `return null` on a doc that fails verification, as the neighbouring cases do.
- **Evidence:**

  ```
  verifyDoc({"checksum":"811c9dc5","version":1}) THREW TypeError: Cannot read properties of undefined (reading 'length')
  verifyDoc({"version":1}) -> null
  verifyDoc({})            -> null
  verifyDoc(null)          -> null
  importSaveDoc({"checksum":"811c9dc5","version":1}) THREW TypeError: ...
  ```

  Severity is limited: the one shipped caller, `importSave` at `js/ui.js:1952-1960`, wraps the call in a
  `try`, so the user sees that catch's message rather than the intended "That save file failed its
  checksum" announcement — a wrong error message rather than a crash.


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

- Deep gameplay through the real UI: this game has no `tests/e2e.mjs`, and the interface is built
  entirely in JS at runtime, so only boot → Play → setup was driven in a browser.
- Audio output (`js/audio.js`) — no audio device in headless Chrome.
- The WebGL presentation layer (`js/render.js`) beyond "it boots without console errors" under
  SwiftShader.

## Runtime artefacts

Starting `server.js` created an untracked `data/` directory (the leaderboard store) inside this game
folder. It is runtime state, not a source change; it is being cleaned up centrally. The two leaderboard
exploits above were run against a **copy** of the game in a scratch directory, so no forged entry was
written to this folder's boards.
