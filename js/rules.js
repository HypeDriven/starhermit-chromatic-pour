// rules.js — Chromatic Pour rules engine.
// Pure, deterministic, serializable. No DOM, no Date, no Math.random.
// Vessels are arrays of color indices, bottom first (last element = top).

import { rulesStream } from './rng.js';

export const RULES_VERSION = 1;

export const INVALID = {
  GAME_OVER: 'game-over',
  OUT_OF_RANGE: 'out-of-range',
  SAME_VESSEL: 'same-vessel',
  SOURCE_EMPTY: 'source-empty',
  DEST_FULL: 'dest-full',
  COLOR_MISMATCH: 'color-mismatch',
};

export const TERMINAL = {
  ALL_UNIFORM: 'all-uniform',
  MOVE_LIMIT: 'move-limit-exceeded',
  TIME_LIMIT: 'time-limit-exceeded',
  ABANDONED: 'abandoned',
};

export const INVALID_MESSAGES = {
  [INVALID.GAME_OVER]: 'This round is already over.',
  [INVALID.OUT_OF_RANGE]: 'That vessel does not exist.',
  [INVALID.SAME_VESSEL]: 'A vessel cannot pour into itself.',
  [INVALID.SOURCE_EMPTY]: 'That vessel is empty.',
  [INVALID.DEST_FULL]: 'The destination vessel is full.',
  [INVALID.COLOR_MISMATCH]: 'Liquids only pour onto a matching color or into an empty vessel.',
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function dealPuzzle(rng, colorCount, capacity, emptyVessels) {
  // Random deal: every color has exactly `capacity` units, dealt across
  // `colorCount` vessels; `emptyVessels` start empty. Validated below.
  const units = [];
  for (let c = 0; c < colorCount; c++) {
    for (let k = 0; k < capacity; k++) units.push(c);
  }
  const shuffled = rng.shuffle(units);
  const vessels = [];
  for (let v = 0; v < colorCount; v++) {
    vessels.push(shuffled.slice(v * capacity, (v + 1) * capacity));
  }
  for (let e = 0; e < emptyVessels; e++) vessels.push([]);
  return vessels;
}

/**
 * Create a new game. Deals a seeded random layout and proves solvability with
 * the built-in solver, retrying with derived sub-seeds until a valid,
 * non-trivial board is found. Deterministic per seed.
 */
export function createGame({ seed, colorCount, capacity = 4, emptyVessels = 2, constraints = {}, vessels = null, minDepth = null }) {
  if (!Number.isInteger(colorCount) || colorCount < 2 || colorCount > 12) {
    throw new Error('colorCount must be an integer 2..12');
  }
  let initial;
  if (vessels) {
    initial = vessels.map((v) => v.slice());
  } else {
    const rng = rulesStream(seed);
    const wantDepth = minDepth ?? Math.max(3, colorCount - 1);
    let accepted = null;
    for (let attempt = 0; attempt < 60 && !accepted; attempt++) {
      const candidate = dealPuzzle(rng.fork(`deal-${attempt}`), colorCount, capacity, emptyVessels);
      if (vesselsSolved(candidate, capacity)) continue;
      const probe = {
        version: RULES_VERSION, seed, colorCount, capacity,
        vessels: candidate.map((v) => v.slice()),
        turn: 0, moves: 0, invalidActions: 0, elapsedMs: 0,
        status: 'active', terminalReason: null,
        constraints: {}, appliedCommandIds: [],
      };
      const sol = solve(probe, { maxNodes: 120000 });
      if (sol.solvable && sol.depth >= wantDepth) accepted = candidate;
    }
    if (!accepted) {
      // Extremely unlikely; accept any solvable deal regardless of depth.
      for (let attempt = 0; attempt < 200 && !accepted; attempt++) {
        const candidate = dealPuzzle(rng.fork(`fallback-${attempt}`), colorCount, capacity, emptyVessels);
        if (vesselsSolved(candidate, capacity)) continue;
        accepted = candidate;
      }
    }
    initial = accepted;
  }
  return {
    version: RULES_VERSION,
    seed,
    colorCount,
    capacity,
    vessels: initial,
    turn: 0,
    moves: 0,
    invalidActions: 0,
    elapsedMs: 0,
    status: 'active',
    terminalReason: null,
    constraints: normalizeConstraints(constraints),
    appliedCommandIds: [],
  };
}

function normalizeConstraints(c) {
  const out = {};
  if (Number.isInteger(c.moveLimit) && c.moveLimit > 0) out.moveLimit = c.moveLimit;
  if (Number.isInteger(c.timeLimitMs) && c.timeLimitMs > 0) out.timeLimitMs = c.timeLimitMs;
  if (c.noUndo) out.noUndo = true;
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function topRun(state, i) {
  const v = state.vessels[i];
  if (!v || v.length === 0) return null;
  const color = v[v.length - 1];
  let layers = 0;
  for (let k = v.length - 1; k >= 0 && v[k] === color; k--) layers++;
  return { color, layers };
}

export function isVesselUniform(v) {
  return v.every((c) => c === v[0]);
}

export function isVesselComplete(state, i) {
  const v = state.vessels[i];
  return v.length === 0 || isVesselUniform(v);
}

function vesselsSolved(vessels, capacity) {
  return vessels.every((v) => v.length === 0 || (v.length === capacity && isVesselUniform(v)));
}

export function isSolved(state) {
  return vesselsSolved(state.vessels, state.capacity);
}

export function canPour(state, from, to) {
  if (state.status !== 'active') return { ok: false, reason: INVALID.GAME_OVER };
  const n = state.vessels.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) {
    return { ok: false, reason: INVALID.OUT_OF_RANGE };
  }
  if (from === to) return { ok: false, reason: INVALID.SAME_VESSEL };
  const run = topRun(state, from);
  if (!run) return { ok: false, reason: INVALID.SOURCE_EMPTY };
  const dst = state.vessels[to];
  if (dst.length >= state.capacity) return { ok: false, reason: INVALID.DEST_FULL };
  if (dst.length > 0 && dst[dst.length - 1] !== run.color) {
    return { ok: false, reason: INVALID.COLOR_MISMATCH };
  }
  const space = state.capacity - dst.length;
  return { ok: true, color: run.color, layers: Math.min(run.layers, space) };
}

/**
 * All legal pours. By default excludes "pointless" pours (a uniform vessel
 * into an empty one — a pure shuffle that never helps), which hints and the
 * tutorial rely on. Gameplay still permits them via canPour.
 */
export function legalPours(state, { includePointless = false } = {}) {
  const out = [];
  if (state.status !== 'active') return out;
  for (let from = 0; from < state.vessels.length; from++) {
    if (state.vessels[from].length === 0) continue;
    const uniform = isVesselUniform(state.vessels[from]);
    for (let to = 0; to < state.vessels.length; to++) {
      const r = canPour(state, from, to);
      if (!r.ok) continue;
      if (!includePointless && uniform && state.vessels[to].length === 0) continue;
      out.push({ from, to, color: r.color, layers: r.layers });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

let cmdCounter = 0;
export function nextCommandId(prefix = 'cmd') {
  // Process-unique, monotonic; the session prefixes with its session id so
  // duplicates are rejected idempotently per game.
  return `${prefix}-${++cmdCounter}`;
}

export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object') return { error: { reason: INVALID.OUT_OF_RANGE, message: 'Malformed command.' } };
  const dupIdx = state.appliedCommandIds.indexOf(cmd.id);
  if (dupIdx !== -1) return { state, events: [], duplicate: true };
  if (cmd.type !== 'pour') return { error: { reason: INVALID.OUT_OF_RANGE, message: `Unknown command type: ${cmd.type}` } };
  const check = canPour(state, cmd.from, cmd.to);
  if (!check.ok) {
    return { error: { reason: check.reason, message: INVALID_MESSAGES[check.reason] } };
  }
  const vessels = state.vessels.map((v) => v.slice());
  const src = vessels[cmd.from];
  const dst = vessels[cmd.to];
  for (let k = 0; k < check.layers; k++) dst.push(src.pop());

  let status = 'active';
  let terminalReason = null;
  const events = [{ type: 'pour', from: cmd.from, to: cmd.to, color: check.color, layers: check.layers }];
  const elapsedMs = Number.isFinite(cmd.elapsedMs) ? Math.max(0, Math.floor(cmd.elapsedMs)) : state.elapsedMs;

  if (vesselsSolved(vessels, state.capacity)) {
    status = 'complete';
    terminalReason = TERMINAL.ALL_UNIFORM;
    events.push({ type: 'complete' });
  } else if (state.constraints.moveLimit && state.moves + 1 > state.constraints.moveLimit) {
    status = 'failed';
    terminalReason = TERMINAL.MOVE_LIMIT;
    events.push({ type: 'failed', reason: terminalReason });
  } else if (state.constraints.timeLimitMs && elapsedMs >= state.constraints.timeLimitMs) {
    status = 'failed';
    terminalReason = TERMINAL.TIME_LIMIT;
    events.push({ type: 'failed', reason: terminalReason });
  }

  const next = {
    ...state,
    vessels,
    turn: state.turn + 1,
    moves: state.moves + 1,
    elapsedMs,
    status,
    terminalReason,
    appliedCommandIds: [...state.appliedCommandIds, cmd.id],
  };
  return { state: next, events };
}

export function recordInvalid(state) {
  return { ...state, invalidActions: state.invalidActions + 1 };
}

export function abandon(state) {
  if (state.status !== 'active') return state;
  return { ...state, status: 'failed', terminalReason: TERMINAL.ABANDONED };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreState(state, parMoves = null) {
  const complete = state.status === 'complete';
  const par = parMoves || Math.max(1, state.colorCount * 4);
  const completion = complete ? 10000 : 0;
  const moveEfficiency = complete ? Math.max(0, (par * 3 - state.moves) * 150) : 0;
  const timeBonus = complete ? Math.max(0, 3000 - Math.floor(state.elapsedMs / 1000) * 10) : 0;
  const invalidPenalty = -50 * state.invalidActions;
  const components = { completion, moveEfficiency, timeBonus, invalidPenalty };
  const total = completion + moveEfficiency + timeBonus + invalidPenalty;
  return {
    total,
    components,
    breakdown: [
      { label: 'Completion', value: completion },
      { label: 'Move efficiency', value: moveEfficiency },
      { label: 'Time bonus', value: timeBonus },
      { label: 'Invalid actions', value: invalidPenalty },
    ],
  };
}

/**
 * Result ordering for leaderboards. a/b:
 * {complete, invalidActions, elapsedMs, sessionId}. Returns <0 if a ranks higher.
 */
export function compareResults(a, b) {
  if (a.complete !== b.complete) return a.complete ? -1 : 1;
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

// ---------------------------------------------------------------------------
// Serialization & hashing
// ---------------------------------------------------------------------------

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  // Version migration hook: version 1 is current. Future versions transform here.
  if (data.version !== RULES_VERSION) {
    if (typeof data.version !== 'number' || data.version > RULES_VERSION) {
      throw new Error(`Unsupported rules state version: ${data.version}`);
    }
    data.version = RULES_VERSION;
  }
  return data;
}

export function hashState(state) {
  const canonical = [
    state.version, state.seed, state.colorCount, state.capacity,
    state.turn, state.moves, state.invalidActions, state.elapsedMs,
    state.status, state.terminalReason || '-',
    JSON.stringify(state.vessels),
  ].join('|');
  // fnv1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Solver (content validation + hints)
// ---------------------------------------------------------------------------

function stateKey(vessels) {
  // Empty vessels are interchangeable for search purposes; sort to collapse.
  return vessels.map((v) => v.join(',')).sort().join(';');
}

function breakpoints(vessels) {
  // Heuristic: adjacent mismatches + mixed-vessel penalty. Lower is closer.
  let h = 0;
  for (const v of vessels) {
    for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1]) h++;
    if (v.length > 0 && !v.every((c) => c === v[0])) h += 1;
  }
  return h;
}

// Minimal binary heap ordered by priority then insertion order (stable-ish).
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(priority, value) {
    this.k.push(priority); this.v.push(value);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const top = this.v[0];
    const lk = this.k.pop(); const lv = this.v.pop();
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this._swap(i, m); i = m;
      }
    }
    return top;
  }
  _swap(a, b) {
    [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
  }
}

/**
 * Search for a solution. Boards up to 6 colors use BFS (optimal depth);
 * larger boards use weighted best-first search (fast, near-optimal).
 * Returns {solvable, depth, moves} where moves is a list of [from, to];
 * depth is null when unsolvable within maxNodes.
 */
export function solve(startState, { maxNodes = 200000, exact = null } = {}) {
  const start = startState.vessels.map((v) => v.slice());
  if (vesselsSolved(start, startState.capacity)) return { solvable: true, depth: 0, moves: [] };
  const useBfs = exact ?? (startState.colorCount <= 6);
  const probe = { ...startState, status: 'active' };
  const seen = new Set([stateKey(start)]);
  const expand = (vessels) => {
    probe.vessels = vessels;
    return legalPours(probe).map((p) => {
      const next = vessels.map((v) => v.slice());
      for (let k = 0; k < p.layers; k++) next[p.to].push(next[p.from].pop());
      return { pour: p, vessels: next };
    });
  };

  if (useBfs) {
    let nodes = 0;
    let frontier = [{ vessels: start, path: [] }];
    while (frontier.length) {
      const nextFrontier = [];
      for (const node of frontier) {
        if (++nodes > maxNodes) return { solvable: false, depth: null, moves: null };
        for (const { pour, vessels } of expand(node.vessels)) {
          const path = [...node.path, [pour.from, pour.to]];
          if (vesselsSolved(vessels, startState.capacity)) {
            return { solvable: true, depth: path.length, moves: path };
          }
          const key = stateKey(vessels);
          if (!seen.has(key)) {
            seen.add(key);
            nextFrontier.push({ vessels, path });
          }
        }
      }
      frontier = nextFrontier;
    }
    return { solvable: false, depth: null, moves: null };
  }

  // Weighted best-first for large boards.
  const heap = new Heap();
  heap.push(breakpoints(start) * 3, { vessels: start, path: [] });
  let nodes = 0;
  while (heap.size) {
    if (++nodes > maxNodes) return { solvable: false, depth: null, moves: null };
    const node = heap.pop();
    for (const { pour, vessels } of expand(node.vessels)) {
      const path = [...node.path, [pour.from, pour.to]];
      if (vesselsSolved(vessels, startState.capacity)) {
        return { solvable: true, depth: path.length, moves: path };
      }
      const key = stateKey(vessels);
      if (!seen.has(key)) {
        seen.add(key);
        heap.push(path.length + breakpoints(vessels) * 3, { vessels, path });
      }
    }
  }
  return { solvable: false, depth: null, moves: null };
}

/**
 * Suggest a move. Prefers the solver's optimal first move; falls back to a
 * heuristic over the same legal-action API when the search budget is exceeded.
 */
export function hint(state) {
  if (state.status !== 'active') return null;
  const solved = solve(state, { maxNodes: 60000 });
  if (solvableMove(solved)) {
    const [from, to] = solved.moves[0];
    const r = canPour(state, from, to);
    return { from, to, color: r.color, layers: r.layers, optimal: true };
  }
  return heuristicHint(state);
}

function solvableMove(s) {
  return s.solvable && s.moves && s.moves.length > 0;
}

function heuristicHint(state) {
  const pours = legalPours(state);
  if (!pours.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const p of pours) {
    let s = 0;
    const dst = state.vessels[p.to];
    const src = state.vessels[p.from];
    if (dst.length > 0) s += 10; // completing/merging a color beats parking
    if (dst.length + p.layers === state.capacity) s += 5; // fills the vessel
    if (isVesselUniform(src) && src.length === state.capacity) s -= 20; // don't disturb finished vessels
    if (p.layers > 1) s += p.layers; // moving contiguous runs is efficient
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best ? { ...best, optimal: false } : null;
}
