// tests/run-tests.js — plain Node test runner (no dependencies).
// Covers: legal/invalid actions, scoring, terminal states, serialization,
// replay determinism, idempotency, fuzzing, golden sessions, content
// validation, legalPours/hints.

import * as rules from '../js/rules.js';
import { GameSession } from '../js/session.js';
import { createRng } from '../js/rng.js';
import * as storage from '../js/storage.js';
import { loadSdkFactory } from './starhermit-harness.mjs';
import * as gfx from '../js/gfx.js';
import { gfxStrings, pickLocale, GFX_LOCALES } from '../js/gfx-strings.js';
import {
  CONTENT_VERSION, COLOR_SETS, THEMES, DIFFICULTIES, LESSONS, JOURNEY, CHALLENGES,
  dailyLevel, practiceLevel, buildLevelState, getLevelById, parFor, validateContent,
} from '../js/content.js';

const t0 = Date.now();
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.error(`FAIL ${name}\n     ${(e.stack || e).split('\n').join('\n     ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'expected equality'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function deepEq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || 'deep equality failed'}:\n${x}\n!==\n${y}`);
}

function makeState(vessels, { colorCount = 2, constraints = {}, seed = 'test-seed' } = {}) {
  return rules.createGame({ seed, colorCount, emptyVessels: 0, constraints, vessels });
}

function firstLegalPour(state) {
  const pours = rules.legalPours(state);
  assert(pours.length > 0, 'expected at least one legal pour');
  return pours[0];
}

// ---------------------------------------------------------------------------
// 1. Legal actions
// ---------------------------------------------------------------------------

test('legal: pour into empty vessel', () => {
  const s = makeState([[0, 1], [1, 0], [], []]);
  const check = rules.canPour(s, 0, 2);
  assert(check.ok, 'pour into empty should be legal');
  eq(check.color, 1);
  eq(check.layers, 1);
  const res = rules.applyCommand(s, { id: 'p1', type: 'pour', from: 0, to: 2, elapsedMs: 0 });
  assert(!res.error, res.error && res.error.message);
  deepEq(res.state.vessels[0], [0]);
  deepEq(res.state.vessels[2], [1]);
  eq(res.state.moves, 1);
  eq(res.events[0].type, 'pour');
});

test('legal: pour onto matching color', () => {
  const s = makeState([[0, 1], [1, 1], [], []]);
  const check = rules.canPour(s, 0, 1);
  assert(check.ok, 'pour onto matching top color should be legal');
  eq(check.color, 1);
  eq(check.layers, 1);
});

test('legal: contiguous run pours as one unit', () => {
  const s = makeState([[0, 1, 1], [1, 0], [], []]);
  const run = rules.topRun(s, 0);
  eq(run.color, 1);
  eq(run.layers, 2, 'top run should be two layers');
  const check = rules.canPour(s, 0, 2);
  assert(check.ok);
  eq(check.layers, 2, 'both contiguous layers move together');
  const res = rules.applyCommand(s, { id: 'p2', type: 'pour', from: 0, to: 2 });
  deepEq(res.state.vessels[0], [0]);
  deepEq(res.state.vessels[2], [1, 1]);
  eq(res.state.moves, 1, 'a multi-layer pour is a single move');
});

test('legal: partial pour when destination space < run', () => {
  const s = makeState([[0, 1, 1, 1], [2, 2, 1], [0, 0, 2], []], { colorCount: 3 });
  const check = rules.canPour(s, 0, 1);
  assert(check.ok);
  eq(check.layers, 1, 'only one layer fits in the destination');
  const res = rules.applyCommand(s, { id: 'p3', type: 'pour', from: 0, to: 1 });
  deepEq(res.state.vessels[0], [0, 1, 1]);
  deepEq(res.state.vessels[1], [2, 2, 1, 1]);
});

test('legal: multi-vessel generated board accepts legalPours', () => {
  const s = rules.createGame({ seed: 'multi-vessel', colorCount: 5, emptyVessels: 2 });
  eq(s.vessels.length, 7);
  const p = firstLegalPour(s);
  const res = rules.applyCommand(s, { id: 'mv', type: 'pour', from: p.from, to: p.to });
  assert(!res.error, res.error && res.error.message);
  eq(res.state.moves, 1);
  eq(res.events[0].layers, p.layers);
});

// ---------------------------------------------------------------------------
// 2. Invalid reasons
// ---------------------------------------------------------------------------

test('invalid: same-vessel', () => {
  const s = makeState([[0, 1], [1, 0], [], []]);
  eq(rules.canPour(s, 0, 0).reason, rules.INVALID.SAME_VESSEL);
});

test('invalid: source-empty', () => {
  const s = makeState([[0, 1], [1, 0], [], []]);
  eq(rules.canPour(s, 2, 0).reason, rules.INVALID.SOURCE_EMPTY);
});

test('invalid: dest-full', () => {
  const s = makeState([[0, 0, 0, 0], [1, 1], [], []]);
  eq(rules.canPour(s, 1, 0).reason, rules.INVALID.DEST_FULL);
});

test('invalid: color-mismatch', () => {
  const s = makeState([[0], [1], [], []]);
  eq(rules.canPour(s, 0, 1).reason, rules.INVALID.COLOR_MISMATCH);
});

test('invalid: out-of-range', () => {
  const s = makeState([[0], [1], [], []]);
  eq(rules.canPour(s, -1, 0).reason, rules.INVALID.OUT_OF_RANGE);
  eq(rules.canPour(s, 0, 99).reason, rules.INVALID.OUT_OF_RANGE);
  eq(rules.canPour(s, 0.5, 0).reason, rules.INVALID.OUT_OF_RANGE);
  eq(rules.canPour(s, NaN, 0).reason, rules.INVALID.OUT_OF_RANGE);
  eq(rules.canPour(s, '0', 1).reason, rules.INVALID.OUT_OF_RANGE);
});

test('invalid: game-over (pour after completion)', () => {
  let s = makeState([[0, 0, 0, 0], [1, 1, 1], [1], []]);
  const res = rules.applyCommand(s, { id: 'fin', type: 'pour', from: 2, to: 1 });
  eq(res.state.status, 'complete');
  eq(rules.canPour(res.state, 0, 2).reason, rules.INVALID.GAME_OVER);
  const again = rules.applyCommand(res.state, { id: 'late', type: 'pour', from: 0, to: 2 });
  assert(again.error, 'pour after completion must be rejected');
  eq(again.error.reason, rules.INVALID.GAME_OVER);
});

// ---------------------------------------------------------------------------
// 3. Scoring
// ---------------------------------------------------------------------------

function scoredState(over) {
  return {
    version: 1, seed: 'sc', colorCount: 4, capacity: 4,
    vessels: [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3], [], []],
    turn: 0, moves: 0, invalidActions: 0, elapsedMs: 0,
    status: 'complete', terminalReason: rules.TERMINAL.ALL_UNIFORM,
    constraints: {}, appliedCommandIds: [], ...over,
  };
}

test('scoring: completion bonus only when complete', () => {
  const done = rules.scoreState(scoredState({}), 10);
  eq(done.components.completion, 10000);
  const notDone = rules.scoreState(scoredState({ status: 'active', terminalReason: null }), 10);
  eq(notDone.components.completion, 0);
  eq(notDone.components.moveEfficiency, 0);
  eq(notDone.components.timeBonus, 0);
});

test('scoring: moveEfficiency decreases with more moves', () => {
  const few = rules.scoreState(scoredState({ moves: 10 }), 10);
  const many = rules.scoreState(scoredState({ moves: 20 }), 10);
  assert(few.components.moveEfficiency > many.components.moveEfficiency, 'fewer moves should score higher');
  eq(few.components.moveEfficiency, (30 - 10) * 150);
  eq(many.components.moveEfficiency, (30 - 20) * 150);
});

test('scoring: invalidPenalty is -50 each; total is the sum of components', () => {
  const s = rules.scoreState(scoredState({ invalidActions: 3, moves: 10, elapsedMs: 60000 }), 10);
  eq(s.components.invalidPenalty, -150);
  const sum = s.components.completion + s.components.moveEfficiency + s.components.timeBonus + s.components.invalidPenalty;
  eq(s.total, sum);
  eq(s.breakdown.reduce((a, b) => a + b.value, 0), s.total, 'breakdown sums to total');
});

test('scoring: compareResults ordering (completion > invalid > elapsed > sessionId)', () => {
  const base = { complete: true, invalidActions: 0, elapsedMs: 5000, sessionId: 'a' };
  assert(rules.compareResults(base, { ...base, complete: false }) < 0, 'completion wins');
  assert(rules.compareResults(base, { ...base, invalidActions: 1 }) < 0, 'fewer invalid wins');
  assert(rules.compareResults(base, { ...base, elapsedMs: 9000 }) < 0, 'lower elapsed wins');
  assert(rules.compareResults(base, { ...base, sessionId: 'b' }) < 0, 'sessionId breaks ties');
  assert(rules.compareResults({ ...base, sessionId: 'b' }, base) > 0, 'ordering is antisymmetric');
  eq(rules.compareResults(base, { ...base }), 0);
});

// ---------------------------------------------------------------------------
// 4. Terminal states
// ---------------------------------------------------------------------------

test('terminal: all-uniform completion', () => {
  const s = makeState([[0, 0, 0, 0], [1, 1, 1], [1], []]);
  const res = rules.applyCommand(s, { id: 't1', type: 'pour', from: 2, to: 1 });
  eq(res.state.status, 'complete');
  eq(res.state.terminalReason, rules.TERMINAL.ALL_UNIFORM);
  assert(res.events.some((e) => e.type === 'complete'), 'complete event emitted');
  assert(rules.isSolved(res.state));
});

test('terminal: move-limit-exceeded', () => {
  const s = makeState([[0, 1], [1, 0], [], []], { constraints: { moveLimit: 1 } });
  const r1 = rules.applyCommand(s, { id: 'm1', type: 'pour', from: 0, to: 2 });
  eq(r1.state.status, 'active', 'first pour is within the limit');
  const r2 = rules.applyCommand(r1.state, { id: 'm2', type: 'pour', from: 1, to: 3 });
  eq(r2.state.status, 'failed');
  eq(r2.state.terminalReason, rules.TERMINAL.MOVE_LIMIT);
  assert(r2.events.some((e) => e.type === 'failed'));
});

test('terminal: abandoned via rules.abandon', () => {
  const s = makeState([[0, 1], [1, 0], [], []]);
  const a = rules.abandon(s);
  eq(a.status, 'failed');
  eq(a.terminalReason, rules.TERMINAL.ABANDONED);
  const done = makeState([[0, 0, 0, 0], [1, 1, 1], [1], []]);
  const fin = rules.applyCommand(done, { id: 't2', type: 'pour', from: 2, to: 1 }).state;
  eq(rules.abandon(fin).status, 'complete', 'abandon on a finished game is a no-op');
});

// ---------------------------------------------------------------------------
// 5. Serialization round-trip
// ---------------------------------------------------------------------------

test('serialization: round-trip deep-equals and hash is stable', () => {
  let s = rules.createGame({ seed: 'serde', colorCount: 4, emptyVessels: 2 });
  const p = firstLegalPour(s);
  s = rules.applyCommand(s, { id: 's1', type: 'pour', from: p.from, to: p.to, elapsedMs: 1234 }).state;
  const json = rules.serialize(s);
  const back = rules.deserialize(json);
  deepEq(back, s, 'deserialize(serialize(s)) must deep-equal s');
  eq(rules.hashState(back), rules.hashState(s), 'hash stable across round-trip');
});

test('serialization: deserialize rejects future versions', () => {
  const s = rules.createGame({ seed: 'serde2', colorCount: 2, emptyVessels: 2 });
  const future = JSON.parse(rules.serialize(s));
  future.version = rules.RULES_VERSION + 1;
  let threw = false;
  try { rules.deserialize(JSON.stringify(future)); } catch { threw = true; }
  assert(threw, 'future version must be rejected');
});

// ---------------------------------------------------------------------------
// 6. Deterministic replay
// ---------------------------------------------------------------------------

function scriptedRun(seed) {
  let state = rules.createGame({ seed, colorCount: 5, emptyVessels: 2 });
  const hashes = [rules.hashState(state)];
  const sol = rules.solve(state, { maxNodes: 200000 });
  assert(sol.solvable, 'scripted board must be solvable');
  sol.moves.forEach(([from, to], i) => {
    const res = rules.applyCommand(state, { id: `rc-${i}`, type: 'pour', from, to, elapsedMs: (i + 1) * 1000 });
    assert(!res.error, `scripted pour ${i} rejected`);
    state = res.state;
    hashes.push(rules.hashState(state));
  });
  return { state, hashes };
}

test('replay: same seed + same commands => identical hashes across two runs', () => {
  const a = scriptedRun('replay-seed');
  const b = scriptedRun('replay-seed');
  deepEq(a.hashes, b.hashes, 'hash sequences must match step for step');
  eq(a.state.status, 'complete');
});

test('replay: different seeds => different initial boards (spot check)', () => {
  const a = rules.createGame({ seed: 'seed-alpha', colorCount: 6, emptyVessels: 2 });
  const b = rules.createGame({ seed: 'seed-beta', colorCount: 6, emptyVessels: 2 });
  assert(JSON.stringify(a.vessels) !== JSON.stringify(b.vessels), 'different seeds should deal different boards');
});

// ---------------------------------------------------------------------------
// 7. Idempotency
// ---------------------------------------------------------------------------

test('idempotency: duplicate command id returns duplicate:true, state unchanged', () => {
  let s = rules.createGame({ seed: 'idem', colorCount: 3, emptyVessels: 2 });
  const p = firstLegalPour(s);
  const cmd = { id: 'dup-1', type: 'pour', from: p.from, to: p.to };
  const r1 = rules.applyCommand(s, cmd);
  assert(!r1.error && !r1.duplicate);
  const hashAfter = rules.hashState(r1.state);
  const turnAfter = r1.state.turn;
  const r2 = rules.applyCommand(r1.state, cmd);
  assert(r2.duplicate, 'second application must be flagged duplicate');
  eq(r2.events.length, 0, 'duplicate emits no events');
  eq(rules.hashState(r2.state), hashAfter, 'hash unchanged');
  eq(r2.state.turn, turnAfter, 'turn unchanged');
  eq(r2.state.moves, r1.state.moves, 'moves unchanged');
});

// ---------------------------------------------------------------------------
// 8. Fuzzing
// ---------------------------------------------------------------------------

test('fuzz: 500 malformed commands never throw, hang, or corrupt state', () => {
  const rng = createRng('fuzz-commands');
  let state = rules.createGame({ seed: 'fuzz-game-0', colorCount: 4, emptyVessels: 2 });
  const garbage = () => rng.pick([-5, -1, 0, 1, 2, 3, 6, 99, 1e9, NaN, 0.5, '1', null, undefined, Infinity]);
  for (let i = 0; i < 500; i++) {
    if (i % 50 === 49) {
      state = rules.createGame({ seed: `fuzz-game-${i}`, colorCount: rng.int(2, 6), emptyVessels: 2 });
    }
    const cmd = {
      id: rng.pick([`fz-${i}`, i, null, undefined, 'dup', {}]),
      type: rng.pick(['pour', 'pour', 'nope', null, 5, undefined]),
      from: garbage(),
      to: garbage(),
      elapsedMs: garbage(),
    };
    let res;
    try {
      res = rules.applyCommand(state, cmd);
    } catch (e) {
      throw new Error(`applyCommand threw on fuzz command #${i}: ${e.message}`);
    }
    if (res && res.state) state = res.state;
    assert(['active', 'complete', 'failed'].includes(state.status), `bad status '${state.status}' at #${i}`);
    assert(Number.isFinite(state.elapsedMs), `elapsedMs not finite at #${i}`);
    assert(Number.isInteger(state.turn) && Number.isInteger(state.moves), `turn/moves not integers at #${i}`);
    for (const v of state.vessels) {
      for (const c of v) {
        assert(Number.isInteger(c) && c >= 0 && c < state.colorCount, `garbage color ${c} in state at #${i}`);
      }
    }
  }
});

test('fuzz: createGame over 100 seeds (colors 2..12) is solvable and not pre-solved', () => {
  const rng = createRng('fuzz-create');
  for (let i = 0; i < 100; i++) {
    const colorCount = 2 + (i % 11);
    const state = rules.createGame({ seed: `fz-create-${rng.int(0, 1e9)}`, colorCount, emptyVessels: 2 });
    assert(!rules.isSolved(state), `pre-solved board at colorCount=${colorCount}`);
    const sol = rules.solve(state, { maxNodes: 120000 });
    assert(sol.solvable, `unsolvable board at colorCount=${colorCount} (iteration ${i})`);
    assert(sol.depth >= 3, `suspiciously shallow board at colorCount=${colorCount}`);
  }
});

// ---------------------------------------------------------------------------
// 9. Golden sessions
// ---------------------------------------------------------------------------

function solveViaSession(levelDef, { sessionId = 'golden', now = () => 0 } = {}) {
  const s = new GameSession(levelDef, { sessionId, now });
  s.start();
  const sol = rules.solve(s.state, { maxNodes: 200000 });
  assert(sol.solvable, `golden level ${levelDef.id} unsolvable`);
  for (const [from, to] of sol.moves) {
    const r = s.pour(from, to);
    assert(r.ok, `golden pour ${from}->${to} rejected: ${r.reason}`);
  }
  return { session: s, moves: sol.moves };
}

function checkGoldenResult(s, expectedMoves) {
  eq(s.state.status, 'complete');
  const res = s.result();
  assert(res.complete, 'result.complete');
  assert(res.score.total > 0, 'score should be positive');
  eq(res.moves, expectedMoves);
  eq(res.invalidActions, 0);
  assert(typeof res.sessionId === 'string' && res.sessionId.length > 0);
  assert(res.assists && res.assists.hints === res.hintsUsed && res.assists.undos === res.undosUsed);
  const env = s.replayEnvelope();
  eq(env.schemaVersion, 1);
  eq(env.commands.length, expectedMoves);
  assert(env.terminal && env.terminal.status === 'complete');
}

test('golden: easy session (4 colors) completes via solver moves', () => {
  const { session, moves } = solveViaSession(practiceLevel('apprentice', 'gold-easy'), { sessionId: 'gold-easy' });
  checkGoldenResult(session, moves.length);
});

test('golden: medium session (6 colors) completes via solver moves', () => {
  const { session, moves } = solveViaSession(practiceLevel('journeyman', 'gold-medium'), { sessionId: 'gold-medium' });
  checkGoldenResult(session, moves.length);
});

test('golden: hard session (8 colors) completes via solver moves', () => {
  const { session, moves } = solveViaSession(practiceLevel('adept', 'gold-hard'), { sessionId: 'gold-hard' });
  checkGoldenResult(session, moves.length);
});

test('golden: interrupted session (snapshot/restore) matches uninterrupted run', () => {
  const level = practiceLevel('journeyman', 'gold-resume');
  const now = () => 0;
  const full = solveViaSession(level, { sessionId: 'resume', now }).session;

  const a = new GameSession(level, { sessionId: 'resume', now });
  a.start();
  const sol = rules.solve(a.state, { maxNodes: 200000 });
  const half = Math.floor(sol.moves.length / 2);
  for (let i = 0; i < half; i++) assert(a.pour(sol.moves[i][0], sol.moves[i][1]).ok);
  a.pause();
  const snap = a.snapshot();

  const b = GameSession.restore(snap, { now });
  b.resume();
  for (let i = half; i < sol.moves.length; i++) {
    const r = b.pour(sol.moves[i][0], sol.moves[i][1]);
    assert(r.ok, `resumed pour ${i} rejected: ${r.reason}`);
  }
  eq(b.state.status, 'complete');
  eq(rules.hashState(b.state), rules.hashState(full.state), 'restored run must match uninterrupted run');
});

test('golden: move-limit session fails correctly', () => {
  const level = {
    id: 't-movelimit', name: 'Move Limit', kind: 'practice', seed: 'tml',
    colorCount: 2, capacity: 4, emptyVessels: 2,
    constraints: { moveLimit: 1 }, vessels: [[0, 1], [1, 0], [], []],
    parMoves: 4, theme: 'ember', contentVersion: CONTENT_VERSION,
  };
  const s = new GameSession(level, { sessionId: 'tml', now: () => 0 });
  s.start();
  assert(s.pour(0, 2).ok);
  assert(s.pour(1, 3).ok, 'the pour itself is legal; the limit ends the game');
  eq(s.state.status, 'failed');
  eq(s.state.terminalReason, rules.TERMINAL.MOVE_LIMIT);
  const res = s.result();
  assert(!res.complete);
  eq(res.terminalReason, rules.TERMINAL.MOVE_LIMIT);
});

test('golden: undo restores prior hash; undo on empty stack returns false', () => {
  const s = new GameSession(practiceLevel('apprentice', 'gold-undo'), { sessionId: 'gu', now: () => 0 });
  s.start();
  eq(s.undo(), false, 'undo on empty stack');
  const h0 = rules.hashState(s.state);
  const p = firstLegalPour(s.state);
  assert(s.pour(p.from, p.to).ok);
  assert(s.canUndo, 'canUndo after a pour');
  eq(s.undo(), true);
  eq(rules.hashState(s.state), h0, 'undo restores the exact prior state');
  eq(s.undo(), false, 'stack exhausted after one undo');
});

test('golden: noUndo constraint disables undo', () => {
  const level = { ...practiceLevel('apprentice', 'gold-noundo'), constraints: { noUndo: true } };
  const s = new GameSession(level, { sessionId: 'gnu', now: () => 0 });
  s.start();
  const p = firstLegalPour(s.state);
  assert(s.pour(p.from, p.to).ok);
  eq(s.canUndo, false, 'canUndo false under noUndo');
  eq(s.undo(), false, 'undo rejected under noUndo');
});

// ---------------------------------------------------------------------------
// 10. Content validation
// ---------------------------------------------------------------------------

test('content: validateContent proves every shipped level', () => {
  const r = validateContent({ maxNodes: 120000 });
  if (!r.ok) console.error('     problems:', r.problems);
  assert(r.ok, `validateContent failed: ${r.problems.join('; ')}`);
  eq(r.checked, JOURNEY.length + CHALLENGES.length + 7);
  eq(r.parUpdates.length, r.checked);
  for (const u of r.parUpdates) assert(Number.isInteger(u.parMoves) && u.parMoves > 0, `bad par for ${u.id}`);
});

test('content: structure (themes, palettes, journey, lessons, challenges)', () => {
  eq(THEMES.length, 5, 'exactly 5 themes');
  for (const t of THEMES) {
    for (const k of ['id', 'name', 'blurb', 'palette', 'bg', 'fog', 'shelf', 'accent', 'ambience']) {
      assert(t[k], `theme ${t.id} missing ${k}`);
    }
  }
  const paletteKeys = ['standard', 'deuteranopia', 'protanopia', 'tritanopia', 'contrast'];
  deepEq(Object.keys(COLOR_SETS).sort(), paletteKeys.sort(), '5 palettes');
  for (const key of paletteKeys) {
    const set = COLOR_SETS[key];
    eq(set.length, 10, `${key} must have 10 colors`);
    eq(new Set(set.map((c) => c.shape)).size, 10, `${key} shapes must be unique`);
    eq(new Set(set.map((c) => c.hex)).size, 10, `${key} hexes must be unique`);
    for (const c of set) {
      assert(c.id && c.name && /^#[0-9A-Fa-f]{6}$/.test(c.hex), `${key} color fields`);
    }
  }
  assert(JOURNEY.length >= 40, 'at least 40 journey stages');
  JOURNEY.forEach((st, i) => {
    eq(st.id, `j${String(i + 1).padStart(2, '0')}`);
    eq(st.mastery, (i + 1) % 5 === 0, `mastery flag on ${st.id}`);
    assert(st.colorCount >= 3 && st.colorCount <= 10, `${st.id} color range`);
    assert(st.seed && st.name && Array.isArray(st.mechanics) && st.mechanics.length > 0, `${st.id} fields`);
    assert(THEMES.some((t) => t.id === st.theme), `${st.id} theme exists`);
  });
  eq(LESSONS.length, 5, '5 lessons');
  for (const l of LESSONS) {
    assert(l.steps.length >= 2, `${l.id} has steps`);
    for (const st of l.steps) {
      assert(st.text && st.setup && st.require && st.hintText, `${l.id} step fields`);
      assert(['select', 'pour', 'pour-color', 'undo', 'restart'].includes(st.require.kind), `${l.id} require kind`);
    }
  }
  eq(CHALLENGES.length, 6, '6 challenges');
  assert(DIFFICULTIES.map((d) => d.id).join(',') === 'apprentice,journeyman,adept,master');
  eq(getLevelById('j01').id, 'j01');
  eq(getLevelById(CHALLENGES[0].id).id, CHALLENGES[0].id);
  eq(getLevelById(LESSONS[0].id).id, LESSONS[0].id);
  eq(getLevelById('nope'), null);
  const par = parFor(JOURNEY[0]);
  assert(Number.isInteger(par) && par > 0, 'parFor returns a positive integer');
});

test('content: lesson required actions are legal when played through in order', () => {
  for (const lesson of LESSONS) {
    let initial = null;
    let state = null;
    const history = [];
    const cmdSeq = { n: 0 };
    const applyPour = (from, to) => {
      history.push(state);
      state = rules.applyCommand(state, { id: `${lesson.id}-${++cmdSeq.n}`, type: 'pour', from, to }).state;
    };
    for (const step of lesson.steps) {
      if (!step.setup.vessels) continue;
      if (!state) {
        initial = buildLevelState({
          id: lesson.id, kind: 'lesson', seed: step.setup.seed,
          colorCount: step.setup.colorCount, capacity: 4,
          emptyVessels: step.setup.emptyVessels, vessels: step.setup.vessels,
          constraints: {}, parMoves: null, theme: 'ember', contentVersion: CONTENT_VERSION,
        });
        state = initial;
      }
      const req = step.require;
      if (req.kind === 'select') {
        assert(state.vessels[req.from] && state.vessels[req.from].length > 0, `${lesson.id}: select target must be non-empty`);
      } else if (req.kind === 'pour') {
        const check = rules.canPour(state, req.from, req.to);
        if (!check.ok) {
          // Only the matching lesson may refuse a pour, and only as a mismatch.
          eq(lesson.id, 'lesson-matching', `${lesson.id}: unexpected illegal required pour ${req.from}->${req.to}`);
          eq(check.reason, rules.INVALID.COLOR_MISMATCH, `${lesson.id}: refusal must be a color mismatch`);
        } else {
          applyPour(req.from, req.to);
        }
      } else if (req.kind === 'pour-color') {
        const p = rules.legalPours(state, { includePointless: true }).find((x) => x.color === req.color);
        assert(p, `${lesson.id}: no legal pour of color ${req.color}`);
        applyPour(p.from, p.to);
      } else if (req.kind === 'undo') {
        assert(history.length > 0, `${lesson.id}: undo step requires a prior pour`);
        state = history.pop();
      } else if (req.kind === 'restart') {
        state = initial;
        history.length = 0;
      }
    }
  }
});

test('content: dailyLevel is deterministic and cycles by day', () => {
  const a = dailyLevel('2026-03-01');
  const b = dailyLevel('2026-03-01');
  deepEq(a, b, 'same date => identical level def');
  eq(a.id, 'daily-2026-03-01');
  eq(a.seed, 'daily-2026-03-01');
  const c = dailyLevel('2026-03-02');
  assert(c.seed !== a.seed, 'different dates => different seeds');
  const viaDate = dailyLevel(new Date(Date.UTC(2026, 2, 1, 12, 30)));
  deepEq(viaDate, a, 'Date input (UTC) matches string input');
  assert(a.colorCount >= 5 && a.colorCount <= 8, 'daily colors cycle 5..8');
  eq(a.emptyVessels, 2);
  assert(THEMES.some((t) => t.id === a.theme), 'daily theme exists');
  const st = buildLevelState(a);
  assert(!rules.isSolved(st), 'daily board not pre-solved');
  let threw = false;
  try { dailyLevel('not-a-date'); } catch { threw = true; }
  assert(threw, 'invalid date rejected');
});

// ---------------------------------------------------------------------------
// 11. legalPours / hint
// ---------------------------------------------------------------------------

test('legalPours: excludes pointless uniform->empty by default, includes on demand', () => {
  const s = makeState([[0, 0], [0, 1], [1, 1], []]);
  const dflt = rules.legalPours(s);
  assert(dflt.length > 0, 'some legal pours exist');
  assert(!dflt.some((p) => p.from === 0 && p.to === 3), 'pointless pour excluded by default');
  const all = rules.legalPours(s, { includePointless: true });
  assert(all.some((p) => p.from === 0 && p.to === 3), 'pointless pour included with includePointless');
  assert(rules.canPour(s, 0, 3).ok, 'pointless pour is still playable via canPour');
});

test('hint: returns a legal pour on 20 random boards', () => {
  for (let i = 0; i < 20; i++) {
    const s = rules.createGame({ seed: `hint-${i}`, colorCount: 4 + (i % 3), emptyVessels: 2 });
    const h = rules.hint(s);
    assert(h, `hint missing on board ${i}`);
    assert(rules.canPour(s, h.from, h.to).ok, `hint ${h.from}->${h.to} is not legal on board ${i}`);
  }
});

test('hint: returns null on completed boards', () => {
  let s = makeState([[0, 0, 0, 0], [1, 1, 1], [1], []]);
  s = rules.applyCommand(s, { id: 'hx', type: 'pour', from: 2, to: 1 }).state;
  eq(s.status, 'complete');
  eq(rules.hint(s), null, 'no hint on a completed board');
  const solvedActive = makeState([[0, 0, 0, 0], [1, 1, 1, 1], [], []]);
  eq(rules.hint(solvedActive), null, 'no hint when already uniform');
});

// ---------------------------------------------------------------------------
// Time-limit enforcement between pours (session.checkTimeout)
// ---------------------------------------------------------------------------

test('session: checkTimeout fails the round when the clock runs out mid-board', () => {
  let nowMs = 1000;
  const level = {
    id: 't-timeout', name: 'Timeout', kind: 'challenge', seed: 'tto',
    colorCount: 2, capacity: 4, emptyVessels: 2,
    constraints: { timeLimitMs: 5000 }, vessels: [[0, 1], [1, 0], [], []],
    parMoves: 4, theme: 'ember', contentVersion: CONTENT_VERSION,
  };
  const s = new GameSession(level, { sessionId: 'tto', now: () => nowMs });
  s.start();
  eq(s.checkTimeout(), false, 'no timeout before the limit');
  nowMs = 7000; // 6 s elapsed > 5 s limit, without any pour
  eq(s.checkTimeout(), true, 'timeout fires once the limit elapses');
  eq(s.state.status, 'failed');
  eq(s.state.terminalReason, rules.TERMINAL.TIME_LIMIT);
  eq(s.state.elapsedMs, 6000, 'authoritative elapsed recorded at failure');
  eq(s.checkTimeout(), false, 'not re-triggered on a terminal state');
  const env = s.replayEnvelope();
  eq(env.terminal.reason, rules.TERMINAL.TIME_LIMIT);
  assert(env.commands.some((c) => c.type === 'timeout'), 'timeout logged for the replay archive');
});

test('session: checkTimeout is a no-op without a time limit or after completion', () => {
  let nowMs = 0;
  const s = new GameSession(practiceLevel('apprentice', 'no-timeout'), { sessionId: 'nt', now: () => nowMs });
  s.start();
  nowMs = 10 * 60 * 1000;
  eq(s.checkTimeout(), false, 'no constraint -> never times out');
  eq(s.state.status, 'active');
});

// ---------------------------------------------------------------------------
// Storage: reset clears local bests and replays
// ---------------------------------------------------------------------------

test('storage: clearLocalProgress erases bests and replays', () => {
  storage.saveBestScore('board-x', { score: 1234, moves: 9, ms: 9000 });
  storage.saveReplayEnvelope({ schemaVersion: 1, commands: [] });
  assert(storage.loadBestScore('board-x'), 'best recorded before clear');
  assert(storage.listReplays().length > 0, 'replay recorded before clear');
  storage.clearLocalProgress();
  eq(storage.loadBestScore('board-x'), null, 'bests cleared');
  eq(storage.listReplays().length, 0, 'replays cleared');
});

// ---------------------------------------------------------------------------
// Platform: launch token + profile nickname (stubbed window/fetch)
// ---------------------------------------------------------------------------

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.error(`FAIL ${name}\n     ${(e.stack || e).split('\n').join('\n     ')}`);
  }
}

function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

// Runs initPlatform on top of the shipped starhermit-sdk.js with a fake
// location + fetch (SDK and own-server calls share the stub); returns
// {platform, calls, sdk}.
function stubResponse(route) {
  const body = route.body;
  return {
    status: route.status,
    ok: route.status >= 200 && route.status < 300,
    statusText: String(route.status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => (body == null ? '' : JSON.stringify(body)),
    arrayBuffer: async () => (route.bytes ? route.bytes.buffer.slice(route.bytes.byteOffset, route.bytes.byteOffset + route.bytes.byteLength) : new ArrayBuffer(0)),
    blob: async () => null,
  };
}
async function withHost({ hash = '', search = '' }, routes) {
  const calls = [];
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevDoc = globalThis.document;
  const win = {
    location: { hash, search, pathname: '/index.html', hostname: 'localhost', href: 'http://localhost/index.html' + search + hash, origin: 'http://localhost' },
    history: { state: null, replaceState() {} },
    addEventListener() {},
  };
  globalThis.window = win;
  globalThis.document = { hidden: false, addEventListener() {} };
  const stub = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const route = typeof routes === 'function' ? routes(url, init) : routes[url];
    return stubResponse(route || { status: 404, body: { error: 'not-found' } });
  };
  globalThis.fetch = stub;
  const sdk = loadSdkFactory().create({ window: win, fetch: stub, setTimeout: () => 0, clearTimeout: () => {} });
  globalThis.StarHermit = sdk.init();
  try {
    const { initPlatform } = await import('../js/platform.js');
    const platform = await initPlatform({ getConsent: () => false });
    return { platform, calls, sdk };
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
  }
}

const USER_ID = 'a1b2c3d4-0000-4000-8000-feedfacecafe';
const PROFILE_URL = `/api/v1/users/${USER_ID}/profile`;

await testAsync('platform: #game_token launch shows the StarHermit nickname', async () => {
  const jwt = fakeJwt({ sub: USER_ID, game_scope: 'chromatic-pour', unique_name: 'albert_raw' });
  const { platform, calls } = await withHost({ hash: `#game_token=${jwt}` }, {
    '/api/v1/time': { status: 200, body: { epochMs: Date.now() } },
    [PROFILE_URL]: { status: 200, body: { id: USER_ID, username: 'albert_raw', nickname: 'Starfox Al' } },
  });
  eq(platform.hosted, true, 'hosted when a game_token fragment is present');
  eq(platform.scope, 'chromatic-pour', 'scope from game_scope claim');
  eq(platform.userId, USER_ID, 'user id from sub claim');
  eq(platform.profile?.displayName, 'Starfox Al', 'display name is the profile nickname, not the username');
  const profileCall = calls.find((c) => c.url === PROFILE_URL);
  assert(profileCall, 'profile endpoint was called');
  eq(profileCall.headers.Authorization, `Bearer ${jwt}`, 'profile request carries the launch token');
  const timeCall = calls.find((c) => c.url === '/api/v1/time');
  eq(timeCall?.headers.Authorization, `Bearer ${jwt}`, 'api calls carry the launch token');
});

await testAsync('platform: nickname only, never the username; neutral id fallback', async () => {
  const jwt = fakeJwt({ sub: USER_ID, game_scope: 'chromatic-pour' });
  const a = await withHost({ hash: `#game_token=${jwt}` }, {
    '/api/v1/time': { status: 200, body: { epochMs: Date.now() } },
    [PROFILE_URL]: { status: 200, body: { id: USER_ID, username: 'albert_raw', nickname: '' } },
  });
  eq(a.platform.profile?.displayName, 'Player a1b2c3', 'neutral shortened id when the nickname is empty (username never displayed)');
  const b = await withHost({ hash: `#game_token=${jwt}` }, {
    '/api/v1/time': { status: 200, body: { epochMs: Date.now() } },
    [PROFILE_URL]: { status: 403, body: { error: 'forbidden' } },
  });
  eq(b.platform.profile?.displayName, 'Player a1b2c3', 'neutral shortened id when the profile is unreadable');
  assert(!b.platform.profile.displayName.includes(USER_ID), 'never leaks the full user id');
});

await testAsync('platform: standalone launch stays guest and makes no requests', async () => {
  const { platform, calls } = await withHost({}, {});
  eq(platform.hosted, false, 'no token -> standalone');
  eq(platform.profile, null, 'no profile -> guest chip');
  eq(await platform.loadCloud(), null, 'no cloud save');
  platform.saveCloud({ x: 1 });
  deepEq(await platform.getSettings(), {}, 'no settings KV');
  platform.mirrorSettings({ music: 1 });
  const b = await platform.loadBindings({ undo: ['KeyU'] });
  deepEq(b, { undo: ['KeyU'] }, 'local bindings');
  eq(platform.inviteLink(), null, 'no invite link');
  eq(platform.canSignIn(), false, 'no sign-in off the platform host');
  eq((await platform.submitScore('b', { score: 1 })).local, true, 'scores stay local');
  eq(calls.length, 0, 'no network calls when standalone');
});

await testAsync('platform: cloud save game:<slug> round-trip, settings KV patch, bindings, invite', async () => {
  const jwt = fakeJwt({ sub: USER_ID, game_scope: 'chromatic-pour', exp: Math.floor(Date.now() / 1000) + 3600 });
  let saved = null;
  let kv = { music: 0.2 };
  const SAVE_URL = '/api/v1/me/cloud-saves/' + encodeURIComponent('game:chromatic-pour');
  const { platform, calls, sdk } = await withHost({ hash: `#game_token=${jwt}` }, (url, init) => {
    const m = init.method || 'GET';
    if (url === PROFILE_URL) return { status: 200, body: { nickname: 'Al' } };
    if (url === SAVE_URL && m === 'PUT') { saved = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return { status: 204 }; }
    if (url === SAVE_URL) return saved ? { status: 200, bytes: new Uint8Array(saved) } : { status: 404 };
    if (url === '/api/v1/games/chromatic-pour/settings' && m === 'PATCH') { kv = { ...kv, ...JSON.parse(init.body).settings }; return { status: 200, body: { settings: kv } }; }
    if (url === '/api/v1/games/chromatic-pour/settings') return { status: 200, body: { settings: kv } };
    if (url === '/api/v1/games/chromatic-pour/controls') return { status: 200, body: { actions: [{ action: 'undo', codes: ['KeyZ'] }] } };
    return null;
  });
  eq(await platform.loadCloud(), null, 'empty slot');
  const doc = storage.checksumDoc({ settings: { music: 0.5 }, progression: { streak: 2 } });
  platform.saveCloud(doc);
  eq(await platform.flushCloud(), true, 'flushed');
  const put = calls.find((c) => c.method === 'PUT');
  eq(put.url, SAVE_URL, 'cloud-save path is game:<slug>');
  deepEq(await platform.loadCloud(), doc, 'cloud round-trip');
  eq((await platform.getSettings()).music, 0.2, 'settings read');
  await sdk.patchSettings({ theme: 'tide' });
  eq(kv.theme, 'tide', 'settings patched');
  const b = await platform.loadBindings({ undo: ['KeyU'], hint: ['KeyH'] });
  deepEq(b, { undo: ['KeyZ'], hint: ['KeyH'] }, 'platform binding overrides');
  eq(platform.inviteLink(), `https://dashboard.starhermit.com/game-invite/${USER_ID}/chromatic-pour`, 'invite link');
});

// ---------------------------------------------------------------------------
// 14. Graphics quality model (js/gfx.js) + panel strings
// ---------------------------------------------------------------------------

test('gfx: detectPreset maps GPU strings to presets; touch caps Auto at balanced', () => {
  eq(gfx.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  eq(gfx.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  eq(gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  eq(gfx.detectPreset('Apple M2 Pro'), 'high');
  eq(gfx.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  eq(gfx.detectPreset('Adreno (TM) 730'), 'balanced');
  eq(gfx.detectPreset(''), 'balanced');
  eq(gfx.detectPreset('Apple M2 Pro', true), 'balanced', 'mobile cap');
  eq(gfx.detectPreset('SwiftShader', true), 'low');
});

test('gfx: resolve uses detected preset for auto, explicit preset otherwise', () => {
  const a = gfx.resolve({}, 'low');
  eq(a.preset, 'low'); eq(a.auto, true); eq(a.shadows, 'off'); eq(a.post, false);
  eq(a.adaptive, true); eq(a.showFps, false);
  const h = gfx.resolve({ preset: 'high' }, 'low');
  eq(h.preset, 'high'); eq(h.auto, false); eq(h.shadows, 'medium'); eq(h.ao, 'on'); eq(h.post, true);
  eq(gfx.resolve({ preset: 'bogus' }, 'nonsense').preset, 'balanced', 'bad input falls back');
});

test('gfx: overrides win over the preset; invalid tiers are ignored', () => {
  const r = gfx.resolve({ preset: 'low', bloom: 'on', shadows: 'sideways', detail: 'detailed' }, 'low');
  eq(r.bloom, 'on'); eq(r.shadows, 'off'); eq(r.detail, 'detailed');
  eq(r.post, true, 'bloom override turns the post chain on');
  eq(gfx.presetTier('high', 'antialias'), 'smaa');
  eq(gfx.presetTier('ultra', 'shadows'), 'high');
});

test('gfx: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  eq(gfx.resolve({ preset: 'high', render_scale: 5 }, 'low').scale, 2);
  eq(gfx.resolve({ preset: 'high', render_scale: 0.1 }, 'low').scale, 0.5);
  eq(gfx.resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  const low = gfx.resolve({ preset: 'low' }, 'low');
  eq(gfx.pixelRatio(low, 3), 1, 'Low caps the pixel ratio at 1');
  eq(gfx.pixelRatio(gfx.resolve({ preset: 'high' }), 3, 0.6), 1.2, 'adaptive scale multiplies');
});

test('gfx: choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const next = gfx.choosePreset({ preset: 'high', bloom: 'off', shadows: 'high', render_scale: 1.5, show_fps: true }, 'low');
  eq(next.preset, 'low'); eq(next.bloom, undefined); eq(next.shadows, undefined);
  eq(next.render_scale, 1.5); eq(next.show_fps, true);
  eq(gfx.choosePreset({}, 'nope').preset, 'auto');
  eq(gfx.migrateQuality('medium').preset, 'balanced');
  eq(gfx.migrateQuality('auto').preset, 'auto');
});

test('gfx: describe summarises cost and pixels', () => {
  const d = gfx.describe(gfx.resolve({ preset: 'high' }), [1280, 720]);
  assert(d.includes('1024² shadows') && d.includes('SMAA') && d.includes('1280×720 px'), d);
  assert(gfx.describe(gfx.resolve({ preset: 'low' })).startsWith('no shadows'));
});

test('gfx strings: all nine locales cover every key; locale matching', () => {
  const en = gfxStrings('en-US');
  eq(GFX_LOCALES.length, 9);
  for (const loc of GFX_LOCALES) {
    const t = gfxStrings(loc);
    for (const k of Object.keys(en)) assert(t[k], `${loc} missing ${k}`);
    for (const cat of Object.keys(gfx.CATEGORIES)) {
      assert(t.cat[cat], `${loc} missing category ${cat}`);
      for (const tier of gfx.CATEGORIES[cat]) assert(t.tier[tier], `${loc} missing tier ${tier}`);
    }
    for (const p of gfx.PRESETS) assert(t.preset[p], `${loc} missing preset ${p}`);
  }
  eq(pickLocale('es-MX'), 'es-419'); eq(pickLocale('fr-CA'), 'fr-CA'); eq(pickLocale('fr'), 'fr-FR');
  eq(pickLocale('pt-PT'), 'pt-BR'); eq(pickLocale('en-AU'), 'en-GB'); eq(pickLocale('ja-JP'), 'en-US');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed;
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (failures.length) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`- ${f.name}: ${f.message}`);
}
console.log(`\nPASS ${passed}/${total} (${secs}s)`);
process.exit(failed ? 1 : 0);
