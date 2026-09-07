// platform.js — StarHermit host adapter. Every call degrades gracefully when
// the game runs standalone (no launch token): scores/leaderboards go local,
// telemetry is dropped, sign-in reports {error:'offline'}.
//
// Telemetry consent is read through the `getConsent` function passed to
// initPlatform(opts.getConsent); when omitted it falls back to
// storage.loadSettings().telemetryConsent. Only funnel events are allowed.

import { loadBestScore, saveBestScore, loadSettings } from './storage.js';

const TIMEOUT_MS = 6000;
const HEARTBEAT_MIN_MS = 25000;
const TELEMETRY_FLUSH_MS = 10000;
const TELEMETRY_QUEUE_MAX = 100;
const ALLOWED_TELEMETRY = new Set([
  'start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error',
]);

function decodeJwtPayload(token) {
  const seg = String(token).split('.')[1];
  if (!seg) return null;
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (seg.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Aggregate-safe telemetry payload: keep numbers/booleans/short enum strings;
// never raw text or pointer trails.
function sanitizeTelemetry(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 32 && !/[\s@/]/.test(v)) out[k] = v;
  }
  return out;
}

export async function initPlatform(opts = {}) {
  const getConsent = typeof opts.getConsent === 'function'
    ? opts.getConsent
    : () => {
        try { return !!loadSettings().telemetryConsent; } catch { return false; }
      };

  // Launch token: read from the URL, decoded for scope, never persisted.
  let token = null;
  let scope = null;
  let profile = null;
  try {
    const q = new URLSearchParams(window.location.search);
    token = q.get('launchToken') || q.get('token') || null;
  } catch {
    token = null;
  }
  if (token) {
    try {
      const payload = decodeJwtPayload(token);
      scope = payload?.scope ?? payload?.game ?? null;
      if (payload?.profile && typeof payload.profile === 'object') {
        profile = {
          displayName: payload.profile.displayName ?? null,
          avatarUrl: payload.profile.avatarUrl ?? null,
        };
      } else if (payload?.displayName || payload?.avatarUrl) {
        profile = { displayName: payload.displayName ?? null, avatarUrl: payload.avatarUrl ?? null };
      }
    } catch {
      token = null; // malformed token: treat as standalone
      scope = null;
    }
  }
  const hosted = !!token;

  let offset = 0;
  let sessionActive = false;
  let lastHeartbeat = 0;
  const telemetryQueue = [];
  let flushTimer = null;

  async function apiFetch(path, { method = 'GET', body, keepalive = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'same-origin',
        keepalive,
      });
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON body */ }
      const out = { status: res.status, json };
      if (res.status === 429) {
        const ra = res.headers.get('Retry-After');
        out.retryAfter = json?.retryAfter ?? (ra != null ? Number(ra) || undefined : undefined);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  function serverNow() {
    return Date.now() + offset;
  }

  async function syncTime() {
    if (!hosted) { offset = 0; return { offset }; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const t0 = Date.now();
        const r = await apiFetch('/api/v1/time');
        const t1 = Date.now();
        if (r.json && typeof r.json.error === 'string') return { error: r.json.error };
        const epoch = r.json && (r.json.epochMs ?? r.json.now);
        if (typeof epoch === 'number' && Number.isFinite(epoch)) {
          offset = epoch + (t1 - t0) / 2 - t1;
          return { offset };
        }
        offset = 0;
        return { error: 'bad-response' };
      } catch {
        if (attempt === 1) { offset = 0; return { error: 'unavailable' }; }
      }
    }
    offset = 0;
    return { error: 'unavailable' };
  }

  function activityStart() {
    if (!hosted || sessionActive) return;
    sessionActive = true;
    apiFetch('/api/v1/activity', { method: 'POST', body: { event: 'start' } }).catch(() => {});
  }

  function activityEnd() {
    if (!hosted || !sessionActive) return;
    sessionActive = false;
    apiFetch('/api/v1/activity', { method: 'POST', body: { event: 'end' }, keepalive: true }).catch(() => {});
  }

  function heartbeat() {
    if (!hosted || !sessionActive) return;
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_MIN_MS) return;
    lastHeartbeat = now;
    apiFetch('/api/v1/presence', { method: 'POST', body: { event: 'heartbeat' } }).catch(() => {});
  }

  function localLeaderboard(board) {
    try {
      const best = loadBestScore(board);
      if (!best) return [];
      return [{ displayName: 'you', local: true, ...best }];
    } catch {
      return [];
    }
  }

  async function submitScore(board, entry) {
    // Always mirror locally when it beats the stored best — a slim record only;
    // the replay envelope stays in the replay archive, not the bests map.
    let localAccepted = false;
    try {
      const r = entry?.result && typeof entry.result === 'object' ? entry.result : entry || {};
      localAccepted = saveBestScore(board, {
        score: r.score ?? 0,
        moves: r.moves ?? null,
        ms: r.elapsedMs ?? r.ms ?? null,
      });
    } catch { /* storage full */ }

    if (!hosted) return { accepted: true, local: true };
    try {
      const r = await apiFetch('/api/v1/scores', { method: 'POST', body: { board, entry } });
      if (r.status === 429) return { error: 'rate-limited', retryAfter: r.retryAfter };
      if (r.json && typeof r.json.error === 'string') return { error: r.json.error };
      if (r.status >= 200 && r.status < 300) {
        const out = { accepted: true };
        if (r.json && typeof r.json.rank === 'number') out.rank = r.json.rank;
        if (localAccepted) out.local = true;
        return out;
      }
      return { error: 'http-' + r.status, local: localAccepted };
    } catch {
      return { error: 'unavailable', local: localAccepted };
    }
  }

  async function fetchLeaderboard(board, boardScope = 'global') {
    if (hosted) {
      try {
        const r = await apiFetch(
          '/api/v1/leaderboard?board=' + encodeURIComponent(board)
            + '&scope=' + encodeURIComponent(boardScope),
        );
        if (r.json && Array.isArray(r.json.entries)) return r.json.entries;
        if (Array.isArray(r.json)) return r.json;
      } catch {
        // fall through to local synthesis
      }
    }
    return localLeaderboard(board);
  }

  function flushTelemetry(keepalive = false) {
    if (!hosted || telemetryQueue.length === 0) return;
    const events = telemetryQueue.splice(0, telemetryQueue.length);
    apiFetch('/api/v1/telemetry', { method: 'POST', body: { events }, keepalive })
      .catch(() => { /* offline: dropped by design */ });
  }

  function telemetry(event, data) {
    if (!ALLOWED_TELEMETRY.has(event)) return;
    let consented = false;
    try { consented = !!getConsent(); } catch { consented = false; }
    if (!consented || !hosted) return;
    if (telemetryQueue.length >= TELEMETRY_QUEUE_MAX) telemetryQueue.shift();
    // Server-side aggregate counts key on `type`; keep the wire field aligned.
    telemetryQueue.push({ type: event, data: sanitizeTelemetry(data), t: serverNow() });
  }

  async function signIn() {
    if (!hosted) return { error: 'offline' };
    try {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/auth/login?next=' + next;
      return { ok: true };
    } catch {
      return { error: 'unavailable' };
    }
  }

  // Durable achievement delivery; the server stores unlocks idempotently.
  async function unlockAchievement(key) {
    if (!hosted) return { error: 'offline' };
    try {
      const r = await apiFetch('/api/v1/achievements', { method: 'POST', body: { key } });
      if (r.json && typeof r.json.error === 'string') return { error: r.json.error };
      return { ok: true };
    } catch {
      return { error: 'unavailable' };
    }
  }

  const platform = {
    hosted, scope, profile,
    serverNow, syncTime,
    activityStart, activityEnd, heartbeat,
    submitScore, fetchLeaderboard,
    telemetry, signIn, unlockAchievement,
  };

  if (hosted) {
    await syncTime().catch(() => {});
    flushTimer = setInterval(() => flushTelemetry(false), TELEMETRY_FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
    try {
      window.addEventListener('pagehide', () => flushTelemetry(true));
    } catch { /* no window events available */ }
  }

  return platform;
}
