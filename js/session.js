// session.js — game session: owns the clock, undo history, command log, and
// replay envelope around the pure rules engine. Node-safe (clock injected).

import * as rules from './rules.js';

export const BUILD_VERSION = '1.0.0';

export class GameSession {
  /**
   * @param levelDef content level definition (see CONTRACTS.md)
   * @param opts {sessionId?: string, now?: () => ms}
   */
  constructor(levelDef, { sessionId, now } = {}) {
    this.level = levelDef;
    this.sessionId = sessionId || `s-${Math.floor(performanceNowSafe() * 1000).toString(36)}-${++sessionCounter}`;
    this.now = now || (() => Date.now());
    this._cmdSeq = 0;
    this._initial = rules.createGame({
      seed: levelDef.seed,
      colorCount: levelDef.colorCount,
      capacity: levelDef.capacity || 4,
      emptyVessels: levelDef.emptyVessels ?? 2,
      constraints: levelDef.constraints || {},
      vessels: levelDef.vessels || null,
    });
    this._state = null;
    this._history = []; // prior states for undo
    this._commands = []; // ordered applied commands (replay log)
    this._stateHashes = [];
    this._selected = null;
    this._hintsUsed = 0;
    this._undosUsed = 0;
    this._startedAt = null;
    this._accumMs = 0; // authoritative elapsed while active
    this._running = false;
  }

  get state() { return this._state; }
  get selected() { return this._selected; }
  get canUndo() {
    return !this.level.constraints?.noUndo && this._history.length > 0 && this._state?.status === 'active';
  }

  start() {
    this._state = this._initial;
    this._startedAt = this.now();
    this._running = true;
    this._stateHashes.push({ turn: this._state.turn, hash: rules.hashState(this._state) });
    return this._state;
  }

  pause() {
    if (!this._running) return;
    this._accumMs = this.elapsedMs();
    this._running = false;
  }

  resume() {
    if (this._running || !this._state || this._state.status !== 'active') return;
    this._startedAt = this.now();
    this._running = true;
  }

  elapsedMs() {
    if (!this._state) return 0;
    if (!this._running) return this._accumMs;
    return this._accumMs + Math.max(0, Math.floor(this.now() - this._startedAt));
  }

  _syncClock() {
    this._accumMs = this.elapsedMs();
    this._startedAt = this.now();
  }

  /**
   * Selection state machine used by every input modality.
   * Returns {kind:'selected', index} | {kind:'pour', from,to,events} |
   *         {kind:'deselected'} | {kind:'error', reason, message, index}
   */
  selectVessel(i) {
    if (!this._state || this._state.status !== 'active') {
      return { kind: 'error', reason: rules.INVALID.GAME_OVER, message: rules.INVALID_MESSAGES[rules.INVALID.GAME_OVER], index: i };
    }
    if (this._selected === null) {
      if (i < 0 || i >= this._state.vessels.length) {
        return { kind: 'error', reason: rules.INVALID.OUT_OF_RANGE, message: rules.INVALID_MESSAGES[rules.INVALID.OUT_OF_RANGE], index: i };
      }
      if (this._state.vessels[i].length === 0) {
        return { kind: 'error', reason: rules.INVALID.SOURCE_EMPTY, message: 'Select a vessel with liquid in it first.', index: i };
      }
      this._selected = i;
      return { kind: 'selected', index: i };
    }
    if (i === this._selected) {
      this._selected = null;
      return { kind: 'deselected', index: i };
    }
    const from = this._selected;
    const attempt = this.pour(from, i);
    if (attempt.ok) {
      return { kind: 'pour', from, to: i, events: attempt.events };
    }
    // On a mismatch, re-select the tapped vessel if it holds liquid — this is
    // the fastest path to the next useful action.
    if (attempt.reason === rules.INVALID.COLOR_MISMATCH && this._state.vessels[i].length > 0) {
      this._selected = i;
      return { kind: 'error', reason: attempt.reason, message: attempt.message, index: i, reselected: true };
    }
    return { kind: 'error', reason: attempt.reason, message: attempt.message, index: i };
  }

  clearSelection() { this._selected = null; }

  pour(from, to) {
    if (!this._state || this._state.status !== 'active') {
      return { ok: false, reason: rules.INVALID.GAME_OVER, message: rules.INVALID_MESSAGES[rules.INVALID.GAME_OVER] };
    }
    this._syncClock();
    const id = `${this.sessionId}:${++this._cmdSeq}`;
    const cmd = { id, type: 'pour', from, to, elapsedMs: this._accumMs };
    const res = rules.applyCommand(this._state, cmd);
    if (res.error) {
      this._state = rules.recordInvalid(this._state);
      // Invalid attempts are part of the authoritative log: hashState covers
      // invalidActions, so replay validators must see them in sequence.
      this._commands.push({ id, type: 'invalid', from, to, elapsedMs: this._accumMs });
      return { ok: false, reason: res.error.reason, message: res.error.message };
    }
    if (res.duplicate) return { ok: true, events: [], duplicate: true };
    this._history.push(this._state);
    this._state = res.state;
    this._commands.push({ id, type: 'pour', from, to, elapsedMs: this._accumMs });
    this._selected = null;
    if (this._state.turn % 4 === 0 || this._state.status !== 'active') {
      this._stateHashes.push({ turn: this._state.turn, hash: rules.hashState(this._state) });
    }
    if (this._state.status !== 'active') this._running = false;
    return { ok: true, events: res.events };
  }

  undo() {
    if (!this.canUndo) return false;
    this._state = this._history.pop();
    this._undosUsed++;
    this._selected = null;
    if (this._state.status === 'active' && !this._running) {
      this._startedAt = this.now();
      this._running = true;
    }
    return true;
  }

  restart() {
    this._state = this._initial;
    this._history = [];
    this._selected = null;
    this._accumMs = 0;
    this._startedAt = this.now();
    this._running = true;
    return this._state;
  }

  hint() {
    if (!this._state || this._state.status !== 'active') return null;
    const h = rules.hint(this._state);
    if (h) this._hintsUsed++;
    return h;
  }

  result() {
    const s = this._state;
    const score = rules.scoreState(s, this.level.parMoves);
    return {
      score,
      complete: s.status === 'complete',
      status: s.status,
      terminalReason: s.terminalReason,
      moves: s.moves,
      invalidActions: s.invalidActions,
      elapsedMs: s.elapsedMs,
      sessionId: this.sessionId,
      hintsUsed: this._hintsUsed,
      undosUsed: this._undosUsed,
      assists: { hints: this._hintsUsed, undos: this._undosUsed },
    };
  }

  replayEnvelope() {
    return {
      schemaVersion: 1,
      build: BUILD_VERSION,
      contentVersion: this.level.contentVersion ?? 1,
      levelId: this.level.id,
      seed: this.level.seed,
      initialHash: rules.hashState(this._initial),
      startedAt: this._startedAt,
      commands: this._commands.slice(),
      stateHashes: this._stateHashes.slice(),
      terminal: this._state.status === 'active' ? null : {
        status: this._state.status,
        reason: this._state.terminalReason,
        score: rules.scoreState(this._state, this.level.parMoves),
      },
    };
  }

  /** Durable snapshot for reconnect / background resume. */
  snapshot() {
    return JSON.stringify({
      version: 1,
      level: this.level,
      sessionId: this.sessionId,
      state: this._state,
      initial: this._initial,
      history: this._history,
      commands: this._commands,
      stateHashes: this._stateHashes,
      hintsUsed: this._hintsUsed,
      undosUsed: this._undosUsed,
      accumMs: this.elapsedMs(),
    });
  }

  static restore(json, { now } = {}) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    const s = new GameSession(d.level, { sessionId: d.sessionId, now });
    s._initial = rules.deserialize(d.initial);
    s._state = rules.deserialize(d.state);
    s._history = d.history.map((h) => rules.deserialize(h));
    s._commands = d.commands;
    s._stateHashes = d.stateHashes;
    s._hintsUsed = d.hintsUsed;
    s._undosUsed = d.undosUsed;
    s._cmdSeq = d.commands.length;
    s._accumMs = d.accumMs;
    s._startedAt = null;
    s._running = false; // caller resumes explicitly after presenting a summary
    return s;
  }
}

let sessionCounter = 0;
function performanceNowSafe() {
  try { return performance.now(); } catch { return 0; }
}
