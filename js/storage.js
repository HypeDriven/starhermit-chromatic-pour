// storage.js — local persistence for settings, progression, replays, bests.
// Node-safe: localStorage is touched only inside functions, behind a feature
// check; when unavailable (or throwing) an in-memory Map is used instead.

const PREFIX = 'chromatic-pour:';
const SAVE_VERSION = 1;
const REPLAY_LIMIT = 20;
const JOURNEY_STAGE_COUNT = 40;

export const SETTINGS_DEFAULTS = {
  music: 0.7, effects: 0.9, ambience: 0.5, voice: 0.8,
  palette: 'standard',
  theme: 'ember',
  quality: 'auto',
  reducedMotion: false, largerText: false, highContrast: false, leftHanded: false,
  holdToConfirm: false, hintsEnabled: true, labelsOnLiquids: true,
  cameraWide: false, tutorialDone: false, telemetryConsent: false,
};

const PROGRESSION_DEFAULTS = {
  version: 1,
  journey: {},        // levelId -> {stars, bestMoves, bestMs}
  dailies: {},        // 'YYYY-MM-DD' -> {score, moves, ms}
  achievements: {},   // key -> iso timestamp
  mastery: { completed: [] },
  sessionsPlayed: 0,
  lastStreakDay: null,
  streak: 0,
};

export const ACHIEVEMENTS = [
  { key: 'first-pour-complete', name: 'First Pour', desc: 'Complete your first round.' },
  { key: 'mechanic-master', name: 'Mechanic Master', desc: 'Complete any mastery stage.' },
  { key: 'streak-3', name: 'Steady Hands', desc: 'Play on 3 consecutive days.' },
  { key: 'adept-clear', name: 'Adept Clear', desc: 'Complete a board with 8 or more colors.' },
  { key: 'completionist', name: 'Completionist', desc: 'Complete all 40 journey stages.' },
];

// ---------------------------------------------------------------- backend

const memory = new Map();
let backendCache;

function backend() {
  if (backendCache !== undefined) return backendCache;
  backendCache = null;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const probe = PREFIX + 'probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      backendCache = localStorage;
    }
  } catch {
    backendCache = null;
  }
  return backendCache;
}

function readRaw(key) {
  const store = backend();
  try {
    if (store) return store.getItem(key);
    return memory.has(key) ? memory.get(key) : null;
  } catch {
    return memory.has(key) ? memory.get(key) : null;
  }
}

function writeRaw(key, value) {
  const store = backend();
  try {
    if (store) { store.setItem(key, value); return; }
  } catch {
    // fall through to memory
  }
  memory.set(key, value);
}

function readJson(key, fallback) {
  const raw = readRaw(key);
  if (raw == null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJson(key, obj) {
  try {
    writeRaw(key, JSON.stringify(obj));
  } catch {
    // serialization failure: drop silently, storage must never throw
  }
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------- checksum

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function checksumDoc(obj) {
  return { version: SAVE_VERSION, checksum: fnv1a(canonical(obj)), data: obj };
}

export function verifyDoc(doc) {
  if (!isPlainObject(doc) || typeof doc.checksum !== 'string') return null;
  if (doc.version !== SAVE_VERSION) return null;
  // A doc with a checksum but no data payload cannot be verified; return null
  // like every other unverifiable doc rather than letting canonical(undefined)
  // produce a non-string that makes fnv1a throw.
  if (!Object.hasOwn(doc, 'data') || doc.data === undefined) return null;
  return fnv1a(canonical(doc.data)) === doc.checksum ? doc.data : null;
}

// ---------------------------------------------------------------- settings

export function loadSettings() {
  const stored = readJson(PREFIX + 'settings', {});
  return { ...SETTINGS_DEFAULTS, ...(isPlainObject(stored) ? stored : {}) };
}

export function saveSettings(s) {
  writeJson(PREFIX + 'settings', { ...SETTINGS_DEFAULTS, ...(isPlainObject(s) ? s : {}) });
}

// ---------------------------------------------------------------- progression

function normalizeProgression(p) {
  const base = JSON.parse(JSON.stringify(PROGRESSION_DEFAULTS));
  if (!isPlainObject(p)) return base;
  const out = { ...base, ...p };
  if (!isPlainObject(out.journey)) out.journey = {};
  if (!isPlainObject(out.dailies)) out.dailies = {};
  if (!isPlainObject(out.achievements)) out.achievements = {};
  if (!isPlainObject(out.mastery) || !Array.isArray(out.mastery.completed)) {
    out.mastery = { completed: [] };
  }
  if (typeof out.sessionsPlayed !== 'number' || out.sessionsPlayed < 0) out.sessionsPlayed = 0;
  if (typeof out.streak !== 'number' || out.streak < 0) out.streak = 0;
  if (typeof out.lastStreakDay !== 'string') out.lastStreakDay = null;
  out.version = 1;
  return out;
}

export function loadProgression() {
  return normalizeProgression(readJson(PREFIX + 'progression', null));
}

export function saveProgression(p) {
  writeJson(PREFIX + 'progression', normalizeProgression(p));
}

// Erase local bests and archived replays (used by "reset all progress").
export function clearLocalProgress() {
  writeJson(PREFIX + 'bests', {});
  writeJson(PREFIX + 'replays', []);
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function prevUtcDay(dayStr) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function computeStars(levelDef, result) {
  if (!result || !result.complete) return 0;
  const par = typeof levelDef.parMoves === 'number' && levelDef.parMoves > 0
    ? levelDef.parMoves : Infinity;
  const moves = typeof result.moves === 'number' ? result.moves : Infinity;
  if (moves <= par) return 3;
  if (moves <= Math.ceil(par * 1.5)) return 2;
  return 1;
}

function evaluateAchievements(progression, levelDef, result, stars, nowMs) {
  const checks = {
    'first-pour-complete': () => !!(result && result.complete),
    'mechanic-master': () => !!(result && result.complete && levelDef.mastery),
    'streak-3': () => progression.streak >= 3,
    'adept-clear': () => !!(result && result.complete && levelDef.colorCount >= 8),
    'completionist': () =>
      Object.values(progression.journey).filter((e) => e && e.stars > 0).length >= JOURNEY_STAGE_COUNT,
  };
  const ts = new Date(nowMs).toISOString();
  const fresh = [];
  for (const { key } of ACHIEVEMENTS) {
    if (progression.achievements[key]) continue; // idempotent
    if (checks[key] && checks[key]()) {
      progression.achievements[key] = ts;
      fresh.push(key);
    }
  }
  return fresh;
}

// recordResult(levelDef, result, {now}?) — `now` is an injectable ms epoch so
// streak/day logic is testable. Returns {progression, newAchievements, stars}.
export function recordResult(levelDef, result, { now = Date.now() } = {}) {
  const progression = loadProgression();
  const complete = !!(result && result.complete);
  const stars = computeStars(levelDef, result);
  const moves = typeof result?.moves === 'number' ? result.moves : null;
  const ms = typeof result?.elapsedMs === 'number' ? result.elapsedMs : null;
  const score = typeof result?.score === 'number' ? result.score : 0;
  const id = String(levelDef?.id ?? 'unknown');
  const kind = levelDef?.kind ?? (id.startsWith('daily-') ? 'daily' : 'journey');
  const day = utcDay(now);

  progression.sessionsPlayed += 1;

  if (complete && kind === 'journey') {
    const prev = progression.journey[id];
    progression.journey[id] = {
      stars: Math.max(stars, prev?.stars ?? 0),
      bestMoves: moves == null ? (prev?.bestMoves ?? null)
        : Math.min(moves, prev?.bestMoves ?? Infinity),
      bestMs: ms == null ? (prev?.bestMs ?? null)
        : Math.min(ms, prev?.bestMs ?? Infinity),
    };
    if (levelDef.mastery && !progression.mastery.completed.includes(id)) {
      progression.mastery.completed.push(id);
    }
  }

  if (complete && kind === 'daily') {
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(id.slice(6)) ? id.slice(6) : day;
    const prev = progression.dailies[dateKey];
    if (!prev || score > (prev.score ?? -Infinity)
        || (score === prev.score && moves != null && moves < (prev.moves ?? Infinity))) {
      progression.dailies[dateKey] = { score, moves, ms };
    }
  }

  // Streak: any completed round counts the UTC day; consecutive days extend it.
  if (complete && progression.lastStreakDay !== day) {
    progression.streak = progression.lastStreakDay === prevUtcDay(day)
      ? progression.streak + 1 : 1;
    progression.lastStreakDay = day;
  }

  const newAchievements = evaluateAchievements(progression, levelDef, result, stars, now);
  saveProgression(progression);
  return { progression, newAchievements, stars };
}

// ---------------------------------------------------------------- replays

export function saveReplayEnvelope(env) {
  const list = readJson(PREFIX + 'replays', []);
  const arr = Array.isArray(list) ? list : [];
  arr.unshift(env);
  writeJson(PREFIX + 'replays', arr.slice(0, REPLAY_LIMIT));
}

export function listReplays() {
  const list = readJson(PREFIX + 'replays', []);
  return Array.isArray(list) ? list : [];
}

// ---------------------------------------------------------------- best scores

function isBetterScore(a, b) {
  if (!b) return true;
  if (!!a.complete !== !!b.complete) return !!a.complete;
  const sa = a.score ?? -Infinity, sb = b.score ?? -Infinity;
  if (sa !== sb) return sa > sb;
  const ma = a.moves ?? Infinity, mb = b.moves ?? Infinity;
  if (ma !== mb) return ma < mb;
  return (a.elapsedMs ?? a.ms ?? Infinity) < (b.elapsedMs ?? b.ms ?? Infinity);
}

export function loadBestScore(boardKey) {
  const bests = readJson(PREFIX + 'bests', {});
  if (!isPlainObject(bests)) return null;
  return bests[boardKey] ?? null;
}

// saveBestScore returns true when the entry beat the stored best (and was kept).
export function saveBestScore(boardKey, entry) {
  const bests = readJson(PREFIX + 'bests', {});
  const map = isPlainObject(bests) ? bests : {};
  if (!isBetterScore(entry, map[boardKey])) return false;
  map[boardKey] = entry;
  writeJson(PREFIX + 'bests', map);
  return true;
}

// ---------------------------------------------------------------- cloud save

export function exportSaveDoc() {
  return checksumDoc({ settings: loadSettings(), progression: loadProgression() });
}

// On checksum/shape failure the incoming document is preserved untouched under
// a conflict key (local data is never overwritten), and {ok:false, conflict}
// is returned so the UI can ask the player which snapshot to keep.
export function importSaveDoc(doc) {
  const data = verifyDoc(doc);
  if (!data || !isPlainObject(data.settings) || !isPlainObject(data.progression)) {
    writeJson(PREFIX + 'conflict:' + Date.now(), { received: doc ?? null });
    return { ok: false, conflict: true };
  }
  saveSettings(data.settings);
  saveProgression(data.progression);
  return { ok: true };
}
