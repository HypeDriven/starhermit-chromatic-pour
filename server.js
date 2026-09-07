// server.js — Chromatic Pour distribution server + StarHermit authoritative API.
// Node >= 18, zero dependencies (node:http/fs/path/url only).
// Run: `node server.js` (PORT env, default 8080).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rules from './js/rules.js';
import * as content from './js/content.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CP_DATA_DIR || path.join(ROOT, 'data');
const PORT = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);

const CONTENT_VERSION = 1;
const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_PER_MIN = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BOARD_RE = /^[a-z0-9-]{1,64}$/;
const ACHIEVEMENT_KEYS = new Set([
  'first-pour-complete', 'mechanic-master', 'streak-3', 'adept-clear', 'completionist',
]);
const TELEMETRY_TYPES = new Set([
  'start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error',
]);

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.opus': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding is a client error, not a server fault.
    return sendJson(res, 400, { error: 'bad-path' });
  }
  if (rel === '/') rel = '/index.html';
  const filePath = path.resolve(ROOT, '.' + rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return sendJson(res, 400, { error: 'bad-path' });
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not-found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not-found' });

  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  };
  const base = path.basename(filePath);
  if (rel === '/index.html') {
    headers['Cache-Control'] = 'no-cache';
  } else if (rel.startsWith('/vendor/') || /-[0-9a-f]{8,}\./.test(base)) {
    headers['Cache-Control'] = 'immutable, max-age=31536000';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      req.resume();
      return reject(Object.assign(new Error('too large'), { code: 'too-large' }));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('too large'), { code: 'too-large' }));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || 'null');
  } catch {
    throw Object.assign(new Error('bad json'), { code: 'bad-json' });
  }
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// JSON-file persistence (data/ created on demand, debounced atomic writes)
// ---------------------------------------------------------------------------

function createStore(filename, initial) {
  const file = path.join(DATA_DIR, filename);
  let data = initial;
  let loaded = false;
  let timer = null;

  function load() {
    if (loaded) return data;
    loaded = true;
    try {
      data = { ...initial, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { /* missing or corrupt -> start fresh */ }
    return data;
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`persist ${filename} failed:`, err.message);
    }
  }
  function save() {
    if (timer) return;
    timer = setTimeout(flush, 250);
    timer.unref?.();
  }
  return {
    get data() { return load(); },
    save,
    flush,
  };
}

const leaderboards = createStore('leaderboards.json', {});
const achievements = createStore('achievements.json', {});
const telemetry = createStore('telemetry.json', { counts: {} });

function flushAll() {
  leaderboards.flush();
  achievements.flush();
  telemetry.flush();
}
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

// ---------------------------------------------------------------------------
// Rate limiting (30 score submissions/min per IP, sliding window)
// ---------------------------------------------------------------------------

const scoreHits = new Map(); // ip -> [timestamps]

function checkScoreRate(ip) {
  const now = Date.now();
  let hits = scoreHits.get(ip) || [];
  hits = hits.filter((t) => now - t < 60000);
  if (hits.length >= RATE_LIMIT_PER_MIN) {
    scoreHits.set(ip, hits);
    return Math.ceil((hits[0] + 60000 - now) / 1000) || 1;
  }
  hits.push(now);
  scoreHits.set(ip, hits);
  return 0;
}

// ---------------------------------------------------------------------------
// Presence (coarse online count; heartbeats expire after 2 minutes)
// ---------------------------------------------------------------------------

const presence = new Map(); // key -> last seen ts
const PRESENCE_TTL_MS = 120000;

function onlineCount() {
  const now = Date.now();
  for (const [k, ts] of presence) if (now - ts > PRESENCE_TTL_MS) presence.delete(k);
  return presence.size;
}

// ---------------------------------------------------------------------------
// Daily board derivation — must match the client's daily ruleset:
// seed `daily-<iso>`, colorCount = 5 + (dayOfYear % 4), 2 empty vessels,
// capacity 4. Only daily boards are re-simulated by the authoritative API.
// ---------------------------------------------------------------------------

function dailyParams(levelId) {
  const m = /^daily-(\d{4})-(\d{2})-(\d{2})$/.exec(String(levelId));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  const dayOfYear = Math.floor((date.getTime() - Date.UTC(+m[1], 0, 1)) / DAY_MS) + 1;
  return {
    id: `daily-${iso}`,
    seed: `daily-${iso}`,
    colorCount: 5 + (dayOfYear % 4),
    capacity: 4,
    emptyVessels: 2,
  };
}

// The server owns the clock: only today's UTC daily is "published" and may be
// submitted. Any past or future daily (a board that has already been or has
// not yet been published) is rejected so no player can pre-solve a board that
// is not live, or re-rank an old daily.
function todayUtcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Boards the authoritative API will re-simulate. Every accepted board must be
// rebuildable server-side from its level id alone:
//  - daily-YYYY-MM-DD   (today only; past/future dailies are rejected)
//  - authored challenges (fixed seeds + constraints in content.js)
//  - score-chase boards  (practice-master-chase-<date|evergreen>, fixed recipe)
// Anything else is unsupported, so no client can submit a self-invented board.
function verifiableParams(levelId) {
  const id = String(levelId);
  const daily = dailyParams(id);
  if (daily) {
    if (daily.id !== `daily-${todayUtcDay()}`) {
      throw new ApiError(422, { error: 'board-not-current' });
    }
    return daily;
  }
  const authored = content.getLevelById(id);
  if (authored && authored.kind === 'challenge') return authored;
  const chase = /^practice-master-(chase-(?:\d{4}-\d{2}-\d{2}|evergreen))$/.exec(id);
  if (chase) {
    try {
      return content.practiceLevel('master', chase[1]);
    } catch {
      return null;
    }
  }
  return null;
}

// parMoves per board, derived by solving once (cached per date). Uses
// content.parFor so the server's par formula (depth + 25% slack) exactly
// matches what the client scored against.
const parCache = new Map();
function parMovesFor(params) {
  let par = parCache.get(params.id);
  if (par !== undefined) return par;
  par = null;
  try {
    par = content.parFor({ ...params, constraints: {}, parMoves: null }, { maxNodes: 200000 });
  } catch { /* fall through */ }
  if (!Number.isInteger(par)) par = params.colorCount * 4; // fallback mirrors scoreState default
  parCache.set(params.id, par);
  return par;
}

// ---------------------------------------------------------------------------
// Score validation helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, payload) {
    super(payload.error);
    this.status = status;
    this.payload = payload;
  }
}

const isInt = (v) => Number.isInteger(v);
const inRange = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;

function sanitizeName(v) {
  if (typeof v !== 'string') return 'Guest';
  // Strip control chars, collapse whitespace, cap at 24 chars.
  const clean = v.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean || 'Guest';
}

function sanitizeId(v, fallback) {
  if (typeof v !== 'string' || !v.length) return fallback;
  return v.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 64) || fallback;
}

function validateScoreBody(body) {
  if (!body || typeof body !== 'object') throw new ApiError(400, { error: 'bad-request' });
  const { board, entry } = body;
  if (typeof board !== 'string' || !BOARD_RE.test(board)) throw new ApiError(400, { error: 'bad-board' });
  if (!entry || typeof entry !== 'object') throw new ApiError(400, { error: 'bad-entry' });

  const { levelId, seed, contentVersion, settings, replay, result } = entry;
  if (typeof levelId !== 'string' || !BOARD_RE.test(levelId)) throw new ApiError(400, { error: 'bad-entry' });
  if (typeof seed !== 'string' || seed.length > 128) throw new ApiError(400, { error: 'bad-entry' });
  if (!isInt(contentVersion)) throw new ApiError(400, { error: 'bad-entry' });
  if (settings !== undefined && (typeof settings !== 'object' || settings === null)) {
    throw new ApiError(400, { error: 'bad-entry' });
  }
  if (!replay || typeof replay !== 'object') throw new ApiError(400, { error: 'bad-replay' });
  if (typeof replay.initialHash !== 'string') throw new ApiError(400, { error: 'bad-replay' });
  if (!Array.isArray(replay.commands) || replay.commands.length > 10000) {
    throw new ApiError(400, { error: 'bad-replay' });
  }
  if (!Array.isArray(replay.stateHashes) || replay.stateHashes.length > replay.commands.length + 1) {
    throw new ApiError(400, { error: 'bad-replay' });
  }
  for (const h of replay.stateHashes) {
    if (!h || typeof h !== 'object' || !isInt(h.turn) || typeof h.hash !== 'string') {
      throw new ApiError(400, { error: 'bad-replay' });
    }
  }
  if (!result || typeof result !== 'object') throw new ApiError(400, { error: 'bad-result' });
  const score = typeof result.score === 'number' ? result.score : result.score?.total;
  if (!isInt(score)) throw new ApiError(400, { error: 'bad-result' });
  if (!inRange(result.moves, 0, 10000)) throw new ApiError(400, { error: 'bad-result' });
  if (!inRange(result.invalidActions, 0, 10000)) throw new ApiError(400, { error: 'bad-result' });
  if (!inRange(result.elapsedMs, 0, DAY_MS)) throw new ApiError(400, { error: 'bad-result' });
  const assists = result.assists && typeof result.assists === 'object' ? result.assists : {};
  if (!inRange(assists.hints ?? 0, 0, 10000) || !inRange(assists.undos ?? 0, 0, 10000)) {
    throw new ApiError(400, { error: 'bad-result' });
  }
  return { board, entry, score };
}

// Re-simulate the replay through the rules engine and verify hashes + score.
function verifyReplay(entry, claimedScore) {
  const params = verifiableParams(entry.levelId);
  if (!params) throw new ApiError(422, { error: 'unsupported-level' });
  if (entry.seed !== params.seed || entry.replay.seed !== params.seed) {
    throw new ApiError(422, { error: 'seed-mismatch' });
  }

  let state;
  try {
    state = rules.createGame(params);
  } catch {
    throw new ApiError(422, { error: 'invalid-replay' });
  }
  const hashByTurn = new Map(entry.replay.stateHashes.map((h) => [h.turn, h.hash]));
  if (rules.hashState(state) !== entry.replay.initialHash || hashByTurn.get(0) !== entry.replay.initialHash) {
    throw new ApiError(422, { error: 'hash-mismatch' });
  }

  // The server owns the clock: elapsed time is cumulative and must be
  // monotonic. A claim that moves backwards is forged and is rejected.
  let lastElapsed = -1;
  for (let i = 0; i < entry.replay.commands.length; i++) {
    const cmd = entry.replay.commands[i];
    if (!cmd || (cmd.type !== 'pour' && cmd.type !== 'invalid') || !isInt(cmd.from) || !isInt(cmd.to) ||
        (cmd.elapsedMs !== undefined && !inRange(cmd.elapsedMs, 0, DAY_MS))) {
      throw new ApiError(422, { error: 'invalid-replay' });
    }
    if (cmd.elapsedMs !== undefined) {
      if (cmd.elapsedMs < lastElapsed) throw new ApiError(422, { error: 'invalid-replay' });
      lastElapsed = cmd.elapsedMs;
    }
    if (cmd.type === 'invalid') {
      // Recorded invalid attempts: hashState covers invalidActions, so they
      // must be replayed in sequence even though they change no layers.
      state = rules.recordInvalid(state);
      continue;
    }
    // Command ids are client-unique; only the move sequence is verified, so
    // ids are replaced with fresh server-generated ones.
    const res = rules.applyCommand(state, {
      id: `srv-${i}`, type: 'pour', from: cmd.from, to: cmd.to, elapsedMs: cmd.elapsedMs,
    });
    if (res.error) throw new ApiError(422, { error: 'invalid-replay', reason: res.error.reason });
    state = res.state;
    const expected = hashByTurn.get(state.turn);
    if (expected !== undefined && expected !== rules.hashState(state)) {
      throw new ApiError(422, { error: 'hash-mismatch' });
    }
  }

  const last = entry.replay.stateHashes[entry.replay.stateHashes.length - 1];
  if (!last || last.turn !== state.turn || last.hash !== rules.hashState(state)) {
    throw new ApiError(422, { error: 'hash-mismatch' });
  }
  if (state.status !== 'complete') throw new ApiError(422, { error: 'not-complete' });
  // The server owns the clock: a completed round cannot have taken zero real
  // time. Combined with the monotonicity check above (a claim that moves
  // backwards is forged), this rejects a replay that simply reports 0ms on
  // every command to claim the full time bonus.
  if (state.elapsedMs <= 0) throw new ApiError(422, { error: 'invalid-replay', reason: 'elapsed-forged' });

  const result = entry.result;
  const recomputed = rules.scoreState(state, parMovesFor(params));
  if (recomputed.total !== claimedScore ||
      result.moves !== state.moves ||
      result.invalidActions !== state.invalidActions ||
      result.elapsedMs !== state.elapsedMs) {
    throw new ApiError(422, { error: 'score-mismatch' });
  }
  return { state, recomputed };
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

function handleTime(req, res) {
  const epochMs = Date.now();
  sendJson(res, 200, { now: new Date(epochMs).toISOString(), epochMs });
}

async function handleSubmitScore(req, res) {
  const body = await readJson(req);
  const retryAfter = checkScoreRate(clientIp(req));
  if (retryAfter > 0) {
    return sendJson(res, 429, { error: 'rate-limited', retryAfter }, { 'Retry-After': String(retryAfter) });
  }
  const { board, entry, score } = validateScoreBody(body);
  if (entry.contentVersion !== CONTENT_VERSION) {
    throw new ApiError(409, { error: 'stale-version' });
  }
  if (entry.levelId !== board) throw new ApiError(400, { error: 'bad-board' });
  const { state, recomputed } = verifyReplay(entry, score);

  const boards = leaderboards.data;
  const list = boards[board] || (boards[board] = []);
  const stored = {
    name: sanitizeName(entry.name),
    score: recomputed.total,
    components: recomputed.components,
    moves: state.moves,
    invalidActions: state.invalidActions,
    elapsedMs: state.elapsedMs,
    assists: {
      hints: entry.result.assists?.hints ?? 0,
      undos: entry.result.assists?.undos ?? 0,
    },
    sessionId: sanitizeId(entry.sessionId || entry.result.sessionId, 'anon'),
    ts: Date.now(),
  };
  list.push(stored);
  // Rank by score desc; ties use compareResults ordering semantics
  // (completion, fewer invalid, lower elapsed, sessionId).
  list.sort((a, b) => (b.score - a.score) || rules.compareResults(
    { complete: true, invalidActions: a.invalidActions, elapsedMs: a.elapsedMs, sessionId: a.sessionId },
    { complete: true, invalidActions: b.invalidActions, elapsedMs: b.elapsedMs, sessionId: b.sessionId },
  ));
  const idx = list.indexOf(stored);
  let rank = null;
  if (idx < 100) {
    rank = idx + 1;
    if (list.length > 100) list.length = 100;
  } else {
    list.splice(idx, 1);
  }
  leaderboards.save();
  sendJson(res, 200, { accepted: true, rank });
}

function handleLeaderboard(req, res, url) {
  const board = url.searchParams.get('board') || '';
  if (!BOARD_RE.test(board)) return sendJson(res, 400, { error: 'bad-board' });
  // scope=friends returns the same global data; the host shell filters real friends.
  const list = (leaderboards.data[board] || []).slice(0, 50).map((e, i) => ({
    name: e.name, score: e.score, moves: e.moves, ms: e.elapsedMs, rank: i + 1,
  }));
  sendJson(res, 200, { entries: list, online: onlineCount() }, { 'X-Online': String(onlineCount()) });
}

async function handleAchievement(req, res) {
  const body = await readJson(req);
  const key = body && typeof body.key === 'string' ? body.key : '';
  if (!ACHIEVEMENT_KEYS.has(key)) return sendJson(res, 400, { error: 'bad-key' });
  const map = achievements.data;
  if (map[key]) return sendJson(res, 200, { ok: true, already: true });
  map[key] = new Date().toISOString();
  achievements.save();
  sendJson(res, 200, { ok: true, already: false });
}

async function handleTelemetry(req, res) {
  const body = await readJson(req);
  const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : [];
  const counts = telemetry.data.counts;
  for (const ev of events) {
    if (ev && typeof ev === 'object' && TELEMETRY_TYPES.has(ev.type)) {
      counts[ev.type] = (counts[ev.type] || 0) + 1;
    }
  }
  if (events.length) telemetry.save();
  sendJson(res, 200, { ok: true });
}

async function handleActivity(req, res) {
  const body = await readJson(req);
  const key = clientIp(req);
  if (body?.event === 'start') presence.set(key, Date.now());
  else if (body?.event === 'end') presence.delete(key);
  sendJson(res, 200, { ok: true });
}

function handlePresence(req, res) {
  presence.set(clientIp(req), Date.now());
  sendJson(res, 200, { ok: true, online: onlineCount() });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { error: 'method-not-allowed' });
      }
      if (req.method === 'GET' && pathname === '/api/v1/time') return handleTime(req, res);
      if (req.method === 'POST' && pathname === '/api/v1/scores') return await handleSubmitScore(req, res);
      if (req.method === 'GET' && pathname === '/api/v1/leaderboard') return handleLeaderboard(req, res, url);
      if (req.method === 'POST' && pathname === '/api/v1/achievements') return await handleAchievement(req, res);
      if (req.method === 'POST' && pathname === '/api/v1/telemetry') return await handleTelemetry(req, res);
      if (req.method === 'POST' && pathname === '/api/v1/activity') return await handleActivity(req, res);
      if (req.method === 'POST' && pathname === '/api/v1/presence') return handlePresence(req, res);
      return sendJson(res, 404, { error: 'not-found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method-not-allowed' });
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof ApiError) return sendJson(res, err.status, err.payload);
    if (err?.code === 'bad-json') return sendJson(res, 400, { error: 'bad-json' });
    if (err?.code === 'too-large') return sendJson(res, 413, { error: 'payload-too-large' });
    console.error('internal error:', err);
    if (!res.headersSent) return sendJson(res, 500, { error: 'internal' });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Chromatic Pour server listening on http://localhost:${server.address().port}`);
});
