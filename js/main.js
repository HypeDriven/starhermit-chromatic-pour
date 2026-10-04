// main.js — Chromatic Pour bootstrap.
// Boot sequence, capability detection, app state machine, rAF loop driving
// the renderer, visibility/resize/orientation handling, graphics settings,
// platform activity lifecycle, and the global error surface. All DOM lives
// in ui.js; this file stays thin.

import * as rules from './rules.js';
import { GameSession } from './session.js';
import { createUI } from './ui.js';
import { detectPreset, migrateQuality, DEFAULT_GRAPHICS } from './gfx.js';

// ---------------------------------------------------------------------------
// App state machine
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS = {
  boot: ['title'],
  title: ['profile-ready', 'mode-select', 'preparing', 'progression'],
  'profile-ready': ['title', 'mode-select', 'preparing', 'progression'],
  'mode-select': ['preparing', 'title', 'progression'],
  preparing: ['tutorial', 'countdown', 'mode-select', 'title'],
  tutorial: ['active', 'title', 'mode-select'],
  countdown: ['active', 'preparing', 'title'],
  active: ['paused', 'resolving', 'title'],
  paused: ['active', 'resolving', 'title', 'countdown', 'paused'],
  resolving: ['results'],
  results: ['progression', 'preparing', 'mode-select', 'title'],
  progression: ['title', 'mode-select', 'preparing'],
};

window.__cpTransitions = [];
let currentState = 'boot';
let ui = null;

function transition(to, { owner = 'main', reason = '' } = {}) {
  const from = currentState;
  if (from === to) return true;
  const allowed = (ALLOWED_TRANSITIONS[from] || []).includes(to);
  window.__cpTransitions.push({ from, to, owner, reason, at: Date.now(), allowed });
  if (!allowed) {
    console.warn(`[chromatic-pour] illegal transition ${from} → ${to} (${owner}: ${reason})`);
    return false;
  }
  currentState = to;
  onStateSideEffects(from, to);
  if (ui) ui.presentState(to);
  return true;
}

// ---------------------------------------------------------------------------
// Module handles (filled during boot)
// ---------------------------------------------------------------------------

let storage = null;
let platform = null;
let content = null;
let audio = null;
let renderMod = null;
let renderer = null;
let webgl = false;
let settings = null;
let gpuName = '';
let detectedPreset = 'balanced';

function isTouchDevice() {
  try {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const fine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    return !!coarse && !fine;
  } catch { return false; }
}

function prefersReducedMotion() {
  return !!(settings?.reducedMotion ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
}

// Minimal offline platform — used only when platform.js is absent or its
// 3 s init budget expires. Matches the contract surface; everything degrades.
function offlinePlatform(note) {
  return {
    hosted: false,
    scope: null,
    userId: null,
    profile: null,
    serverNow: () => Date.now(),
    syncTime: async () => {},
    fetchProfile: async () => null,
    onProfile: () => () => {},
    activityStart: () => {},
    activityEnd: () => {},
    heartbeat: () => {},
    submitScore: async () => ({ error: note }),
    fetchLeaderboard: async () => ({ error: note }),
    unlockAchievement: async () => ({ error: note }),
    telemetry: () => {},
    signIn: async () => {},
    canSignIn: () => false,
    loadCloud: async () => null,
    saveCloud: () => {},
    flushCloud: async () => false,
    getSettings: async () => ({}),
    mirrorSettings: () => {},
    loadBindings: async (d) => d,
    setControls: async () => null,
    resetControls: async () => null,
    inviteLink: () => null,
    copyInvite: async () => false,
    onAuth: () => () => {},
  };
}

// Preferences mirrored to the StarHermit settings KV (not tutorial state,
// telemetry consent or key bindings — those have their own homes).
const SYNCED_SETTINGS = ['music', 'effects', 'ambience', 'voice', 'palette', 'theme', 'graphics', 'reducedMotion',
  'largerText', 'highContrast', 'leftHanded', 'holdToConfirm', 'hintsEnabled', 'labelsOnLiquids', 'cameraWide'];
function syncedSettings(s) {
  const out = {};
  for (const k of SYNCED_SETTINGS) if (s && s[k] !== undefined) out[k] = s[k];
  return out;
}

async function restoreFromPlatform() {
  try {
    const doc = await platform.loadCloud();
    if (doc) storage.importSaveDoc(doc);
    const kv = await platform.getSettings();
    const picked = syncedSettings(kv);
    if (Object.keys(picked).length) storage.saveSettings({ ...storage.loadSettings(), ...picked });
  } catch { /* local save stays authoritative */ }
}

function fatalBoot(title, detail) {
  const app = document.getElementById('app');
  app.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'cp-fatal';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  wrap.append(h, p);
  app.append(wrap);
}

// ---------------------------------------------------------------------------
// Renderer mounting (ui owns the canvas element; main owns the instance)
// ---------------------------------------------------------------------------

async function mountRenderer({ canvas, container, theme, paletteColors, onVesselPick }) {
  if (!webgl || !renderMod) return null;
  try {
    renderer = await renderMod.createRenderer({
      canvas,
      container,
      theme,
      paletteColors,
      decorSeed: `chromatic-pour-${settings?.theme || 'ember'}`,
      // The semantic DOM board is the playable surface; the 3D scene provides
      // the alchemist-shelf environment, lighting, and celebrations around it.
      settings: { ...settings, reducedMotion: prefersReducedMotion(), ambientOnly: true },
      graphics: settings?.graphics || {},
      detectedPreset,
      gpu: gpuName,
      onVesselPick,
    });
    renderer.resize(container?.clientWidth || window.innerWidth, container?.clientHeight || window.innerHeight, window.devicePixelRatio || 1);
    return renderer;
  } catch (_) {
    renderer = null;
    webgl = false;
    return null;
  }
}

function clearRenderer() {
  renderer = null;
}

function updateRenderer({ settings: next } = {}) {
  if (next) settings = next;
  if (!renderer) return;
  try {
    renderer.setGraphics(settings.graphics || {}, detectedPreset);
    renderer.setReducedMotion(prefersReducedMotion());
  } catch { /* renderer settings are best-effort */ }
}

function graphicsInfo() {
  if (renderer) {
    try { return renderer.graphicsInfo(); } catch { /* fall through */ }
  }
  return { gpu: gpuName, detected: detectedPreset, webgl, postFailed: false, postActive: false };
}

// ---------------------------------------------------------------------------
// Activity lifecycle + heartbeat (driven by state transitions)
// ---------------------------------------------------------------------------

let heartbeatTimer = 0;
let activityOpen = false;

function onStateSideEffects(from, to) {
  if (to === 'active' && from !== 'paused') {
    if (!activityOpen) {
      activityOpen = true;
      try { platform.activityStart(); } catch { /* best-effort */ }
    }
    startHeartbeat();
  }
  if (to === 'active' && from === 'paused') startHeartbeat();
  if (from === 'active' || from === 'paused' || to === 'results') {
    if (to !== 'active' && to !== 'paused') stopHeartbeat();
  }
  if (to === 'results' || to === 'title' || to === 'mode-select') {
    if (activityOpen && from !== 'mode-select') {
      activityOpen = false;
      try { platform.activityEnd(); } catch { /* best-effort */ }
    }
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (currentState === 'active') {
      try { platform.heartbeat(); } catch { /* best-effort */ }
    }
  }, 30000);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

// ---------------------------------------------------------------------------
// rAF loop (adaptive resolution lives in the renderer)
// ---------------------------------------------------------------------------

let lastFrame = 0;

function frame(now) {
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;
  if (renderer && !document.hidden) {
    try { renderer.renderFrame(dt); } catch { /* a bad frame must not kill the loop */ }
  }
  if (ui) ui.tick(dt);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Visibility, resize, errors
// ---------------------------------------------------------------------------

let hiddenAt = 0;

function wireLifecycle() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      try { ui?.getSession()?.pause(); } catch { /* best-effort */ }
      try { audio?.suspend(); } catch { /* best-effort */ }
      try { renderer?.setPaused(true); } catch { /* best-effort */ }
    } else {
      const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
      try { audio?.resume(); } catch { /* best-effort */ }
      try { renderer?.setPaused(false); } catch { /* best-effort */ }
      try { ui?.getSession()?.resume(); } catch { /* best-effort */ }
      if (ui && awayMs) ui.announceWhileAway(awayMs);
    }
  });

  const onResize = () => {
    try { renderer?.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1); } catch { /* best-effort */ }
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.matchMedia) {
    // Re-arm a DPR watcher (moving between monitors changes devicePixelRatio).
    let dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const rearm = () => {
      onResize();
      dprQuery.removeEventListener('change', rearm);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', rearm);
    };
    dprQuery.addEventListener('change', rearm);
  }

  const surfaceError = (category) => {
    try { ui?.showError(category); } catch { /* ui may not exist yet */ }
    try { platform?.telemetry('error', { category }); } catch { /* best-effort */ }
  };
  window.addEventListener('error', () => surfaceError('script'));
  window.addEventListener('unhandledrejection', () => surfaceError('promise'));

  // WebAudio requires a user gesture before it can speak.
  const unlock = () => {
    try { audio?.unlock(); } catch { /* best-effort */ }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wireLifecycle();

  // Settings storage (hard dependency of the UI shell).
  try {
    storage = await import('./storage.js');
  } catch (err) {
    console.error('[chromatic-pour] storage.js failed to load', err);
    fatalBoot('The ledger is missing', 'Local storage support could not start. Reload the page; if it persists, this browser may block storage.');
    return;
  }
  // Platform handshake — never block boot longer than 3 s.
  try {
    const platformMod = await import('./platform.js');
    platform = await Promise.race([
      platformMod.initPlatform(),
      new Promise((resolve) => setTimeout(() => resolve(offlinePlatform('timeout')), 3000)),
    ]);
    if (!platform || typeof platform.serverNow !== 'function') platform = offlinePlatform('invalid');
  } catch (err) {
    console.warn('[chromatic-pour] platform unavailable', err);
    platform = offlinePlatform('unavailable');
  }

  // Signed in: the cloud save (remote wins; checksum-verified) and then the
  // platform settings KV (wins over saved preferences) land in local storage
  // before anything reads settings. Bounded so boot never waits long.
  if (platform.hosted) {
    await Promise.race([restoreFromPlatform(), new Promise((r) => setTimeout(r, 3000))]);
  }
  storage.onSaveChange(() => {
    if (!platform.hosted) return;
    platform.saveCloud(storage.exportSaveDoc());
    platform.mirrorSettings(syncedSettings(storage.loadSettings()));
  });

  try {
    settings = storage.loadSettings();
  } catch {
    settings = { ...(storage.SETTINGS_DEFAULTS || {}) };
  }
  // Graphics presets replaced the old single 'quality' select; carry it over once.
  if (!settings.graphics || typeof settings.graphics !== 'object') {
    settings.graphics = migrateQuality(settings.quality);
  } else {
    settings.graphics = { ...DEFAULT_GRAPHICS, ...settings.graphics };
  }

  // WebGL capability + render module (decorative layer; absence is fine).
  try {
    renderMod = await import('./render.js');
    const probe = renderMod.probeGpu();
    webgl = probe.available;
    gpuName = probe.gpu;
    detectedPreset = detectPreset(gpuName, isTouchDevice());
  } catch (err) {
    console.warn('[chromatic-pour] render.js unavailable, classic view', err);
    renderMod = null;
    webgl = false;
  }

  // Audio (fully procedural; absence is fine).
  try {
    const audioMod = await import('./audio.js');
    audio = audioMod.createAudio(settings, { audioSeed: 'chromatic-pour' });
  } catch (err) {
    console.warn('[chromatic-pour] audio unavailable', err);
    audio = null;
  }

  // Content (hard dependency — modes cannot be built without it).
  try {
    content = await import('./content.js');
  } catch (err) {
    console.error('[chromatic-pour] content.js failed to load', err);
    fatalBoot('The level ledger failed to load', 'Game content could not be read. Reload the page to try again.');
    return;
  }

  const services = {
    storage,
    platform,
    audio,
    content,
    rules,
    GameSession,
    getRenderer: () => renderer,
    isWebGL: webgl,
    transition,
    settings,
    saveSettings: (s) => {
      try { storage.saveSettings(s); } catch { ui?.showError('storage'); }
    },
    mountRenderer,
    clearRenderer,
    updateRenderer,
    graphicsInfo,
  };

  ui = createUI({ root: document.getElementById('app'), services });

  try { platform.syncTime(); } catch { /* server time falls back to Date.now() */ }

  lastFrame = performance.now();
  requestAnimationFrame(frame);

  transition('title', { owner: 'main', reason: 'boot-complete' });
}

boot();
