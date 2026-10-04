// platform.js — StarHermit host adapter over window.StarHermit
// (starhermit-sdk.js, loaded and init()ed from index.html before the game
// modules). The SDK reads the launch token (#game_token from the library,
// #access_token after a direct sign-in), strips it from the URL, renews it,
// and owns profile, avatar, cloud save (slot game:<slug>), settings KV,
// control bindings, invite link and sign-in. Every call degrades gracefully
// standalone (no token): nothing touches the network, scores/leaderboards go
// local, telemetry is dropped.
//
// Score/leaderboard/achievement/telemetry/activity/presence/time routes are
// the game's own server backend (server.js) and are only called when
// signed in. Telemetry consent is read through `opts.getConsent` (default:
// storage.loadSettings().telemetryConsent); only funnel events are allowed.

import { loadBestScore, saveBestScore, loadSettings } from './storage.js';

const TIMEOUT_MS = 6000;
const HEARTBEAT_MIN_MS = 25000;
const TELEMETRY_FLUSH_MS = 10000;
const TELEMETRY_QUEUE_MAX = 100;
const ALLOWED_TELEMETRY = new Set([
  'start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error',
]);

const sdk = () => globalThis.StarHermit || null;
const SAVE_DEBOUNCE_MS = 2000;

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

  const SH = sdk();
  const isHosted = () => !!(SH && SH.signedIn);
  let profile = null;
  const profileListeners = new Set();

  let offset = 0;
  let sessionActive = false;
  let lastHeartbeat = 0;
  const telemetryQueue = [];
  let flushTimer = null;

  async function apiFetch(path, { method = 'GET', body, keepalive = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (SH && SH.token) headers.Authorization = 'Bearer ' + SH.token;
      const res = await fetch(path, {
        method,
        headers,
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

  // Token renewal is the SDK's (launch-token chain); kept for the API.
  function refreshToken() { return SH ? SH.refresh().then((t) => !!t) : Promise.resolve(false); }

  async function syncTime() {
    if (!isHosted()) { offset = 0; return { offset }; }
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

  // The signed-in player's nickname (SDK: nickname, 'Player <id>' fallback;
  // never the username) and avatar for the profile chip.
  async function fetchProfile() {
    if (!isHosted()) return profile;
    const p = await SH.profile();
    const avatarUrl = await SH.avatarUrl();
    profile = {
      displayName: String((p && p.displayName) || 'Player').slice(0, 40),
      avatarUrl: avatarUrl || null,
      userId: SH.userId,
    };
    platform.profile = profile;
    notifyProfile();
    return profile;
  }

  function onProfile(fn) {
    if (typeof fn !== 'function') return () => {};
    profileListeners.add(fn);
    return () => profileListeners.delete(fn);
  }

  function notifyProfile() {
    for (const fn of profileListeners) {
      try { fn(profile); } catch { /* listener errors never break the adapter */ }
    }
  }

  function activityStart() {
    if (!isHosted() || sessionActive) return;
    sessionActive = true;
    apiFetch('/api/v1/activity', { method: 'POST', body: { event: 'start' } }).catch(() => {});
  }

  function activityEnd() {
    if (!isHosted() || !sessionActive) return;
    sessionActive = false;
    apiFetch('/api/v1/activity', { method: 'POST', body: { event: 'end' }, keepalive: true }).catch(() => {});
  }

  function heartbeat() {
    if (!isHosted() || !sessionActive) return;
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

    if (!isHosted()) return { accepted: true, local: true };
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
    if (isHosted()) {
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
    if (!isHosted() || telemetryQueue.length === 0) return;
    const events = telemetryQueue.splice(0, telemetryQueue.length);
    apiFetch('/api/v1/telemetry', { method: 'POST', body: { events }, keepalive })
      .catch(() => { /* offline: dropped by design */ });
  }

  function telemetry(event, data) {
    if (!ALLOWED_TELEMETRY.has(event)) return;
    let consented = false;
    try { consented = !!getConsent(); } catch { consented = false; }
    if (!consented || !isHosted()) return;
    if (telemetryQueue.length >= TELEMETRY_QUEUE_MAX) telemetryQueue.shift();
    // Server-side aggregate counts key on `type`; keep the wire field aligned.
    telemetryQueue.push({ type: event, data: sanitizeTelemetry(data), t: serverNow() });
  }

  // Sign in through StarHermit (redirect; returns with #access_token) when
  // served from <slug>.starhermit.com without a token.
  async function signIn() {
    if (isHosted()) return { ok: true, note: 'Already signed in via the platform.' };
    if (SH && SH.canSignIn() && SH.signIn()) return { ok: true, redirecting: true };
    return { error: 'offline', note: 'Launch the game from StarHermit to sign in.' };
  }

  // ---- cloud save: the checksummed {settings, progression} doc in the slot
  // game:<slug>; remote wins on boot, saves debounce and flush on pagehide.
  function loadCloud() { return isHosted() ? SH.loadJSON().catch(() => null) : Promise.resolve(null); }
  function saveCloud(doc) { if (isHosted()) SH.saveJSON(doc, SAVE_DEBOUNCE_MS); }
  function flushCloud() { return isHosted() ? SH.flushSave(true) : Promise.resolve(false); }

  // ---- settings KV: preferences mirrored after the KV was read once.
  let kvReady = false;
  let kvLast = null;
  let kvTimer = 0;
  async function getSettings() {
    if (!isHosted()) return {};
    const kv = await SH.getSettings().catch(() => ({}));
    kvReady = true;
    return kv || {};
  }
  function mirrorSettings(patch) {
    if (!isHosted() || !kvReady) return;
    const json = JSON.stringify(patch);
    if (json === kvLast) return;
    clearTimeout(kvTimer);
    kvTimer = setTimeout(() => { kvLast = json; SH.patchSettings(patch); }, 800);
  }

  // ---- controls: { action: [codes] } with the player's platform overrides.
  function loadBindings(defaults) {
    return isHosted() ? SH.loadBindings(defaults).catch(() => defaults) : Promise.resolve(defaults);
  }
  function setControls(bindings) { return isHosted() ? SH.setControls(bindings).catch(() => null) : Promise.resolve(null); }
  function resetControls() { return isHosted() ? SH.resetControls() : Promise.resolve(null); }

  // ---- invite link (signed in) and auth changes (renewal refused).
  function inviteLink() { return isHosted() ? SH.inviteLink() : null; }
  async function copyInvite() {
    const link = inviteLink();
    if (!link) return false;
    try { await navigator.clipboard.writeText(link); return true; } catch { return false; }
  }
  function onAuth(fn) { return SH ? SH.on('auth', fn) : () => {}; }

  // Durable achievement delivery; the server stores unlocks idempotently.
  async function unlockAchievement(key) {
    if (!isHosted()) return { error: 'offline' };
    try {
      const r = await apiFetch('/api/v1/achievements', { method: 'POST', body: { key } });
      if (r.json && typeof r.json.error === 'string') return { error: r.json.error };
      return { ok: true };
    } catch {
      return { error: 'unavailable' };
    }
  }

  const platform = {
    get hosted() { return isHosted(); },
    get scope() { return SH ? SH.slug : null; },
    get userId() { return SH ? SH.userId : null; },
    profile,
    serverNow, syncTime,
    refreshToken,
    fetchProfile, onProfile,
    activityStart, activityEnd, heartbeat,
    submitScore, fetchLeaderboard,
    telemetry, signIn, unlockAchievement,
    canSignIn: () => !!(SH && SH.canSignIn()),
    loadCloud, saveCloud, flushCloud,
    getSettings, mirrorSettings,
    loadBindings, setControls, resetControls,
    inviteLink, copyInvite, onAuth,
  };

  if (SH) {
    SH.on('auth', (a) => {
      if (!a.signedIn) { profile = null; platform.profile = null; notifyProfile(); }
    });
  }

  if (isHosted()) {
    // Clock sync and profile lookup run together; the profile is given a short
    // budget here so boot is never held up — a late answer still lands via
    // onProfile listeners. Token renewal is the SDK's.
    const profileReady = fetchProfile().catch(() => profile);
    await Promise.all([
      syncTime().catch(() => {}),
      Promise.race([profileReady, new Promise((r) => setTimeout(r, 2000))]),
    ]);
    flushTimer = setInterval(() => flushTelemetry(false), TELEMETRY_FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
    try {
      window.addEventListener('pagehide', () => { flushTelemetry(true); flushCloud(); });
      document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloud(); });
    } catch { /* no window events available */ }
  }

  return platform;
}
