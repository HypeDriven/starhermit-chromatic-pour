// main.js — Chromatic Pour bootstrap.
// Boot sequence, capability detection, app state machine, rAF loop driving
// the renderer, visibility/resize/orientation handling, quality stepping,
// platform activity lifecycle, and the global error surface. All DOM lives
// in ui.js; this file stays thin.

import * as rules from './rules.js';
import { GameSession } from './session.js';
import { createUI } from './ui.js';

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
let qualityTier = 'medium';
let tierDroppedThisSession = false;

// Minimal offline platform — used only when platform.js is absent or its
// 3 s init budget expires. Matches the contract surface; everything degrades.
function offlinePlatform(note) {
  return {
    hosted: false,
    scope: null,
    profile: null,
    serverNow: () => Date.now(),
    syncTime: async () => {},
    activityStart: () => {},
    activityEnd: () => {},
    heartbeat: () => {},
    submitScore: async () => ({ error: note }),
    fetchLeaderboard: async () => ({ error: note }),
    unlockAchievement: async () => ({ error: note }),
    telemetry: () => {},
    signIn: async () => {},
  };
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
      settings: { ...settings, ambientOnly: true },
      onVesselPick,
    });
    applyQualityTier();
    renderer.setReducedMotion(!!settings?.reducedMotion);
    const onResize = () => renderer && renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    onResize();
    return renderer;
  } catch (err) {
    console.warn('[chromatic-pour] renderer creation failed', err);
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
    if (settings.quality !== 'auto') {
      qualityTier = settings.quality;
    }
    applyQualityTier();
    renderer.setReducedMotion(!!settings.reducedMotion);
  } catch { /* renderer settings are best-effort */ }
}

function computeAutoTier() {
  const dpr = window.devicePixelRatio || 1;
  const desktopish = window.innerWidth >= 1024;
  return dpr >= 2 && desktopish ? 'high' : 'medium';
}

function applyQualityTier() {
  if (!renderer) return;
  if (settings?.quality === 'auto') qualityTier = computeAutoTier();
  else if (settings?.quality) qualityTier = settings.quality;
  try { renderer.setQuality(qualityTier); } catch { /* best-effort */ }
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
// rAF loop + FPS monitor (render scale before anything else)
// ---------------------------------------------------------------------------

let lastFrame = 0;
let fpsFrames = 0;
let fpsWindowStart = 0;

function frame(now) {
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;
  if (renderer && !document.hidden) {
    try { renderer.renderFrame(dt); } catch { /* a bad frame must not kill the loop */ }
  }
  if (ui) ui.tick(dt);
  fpsMonitor(now);
  requestAnimationFrame(frame);
}

function fpsMonitor(now) {
  if (currentState !== 'active' || !renderer || tierDroppedThisSession) {
    fpsFrames = 0;
    fpsWindowStart = now;
    return;
  }
  if (!fpsWindowStart) fpsWindowStart = now;
  fpsFrames += 1;
  const elapsed = now - fpsWindowStart;
  if (elapsed < 5000) return;
  const avg = (fpsFrames * 1000) / elapsed;
  fpsFrames = 0;
  fpsWindowStart = now;
  if (avg >= 45) return;
  const order = ['high', 'medium', 'low'];
  const idx = order.indexOf(qualityTier);
  if (idx === -1 || idx >= order.length - 1) return;
  qualityTier = order[idx + 1];
  tierDroppedThisSession = true;
  try { renderer.setQuality(qualityTier); } catch { /* best-effort */ }
  if (ui) ui.notify(`The shelf was dropping frames, so visual quality stepped down to ${qualityTier}.`);
  try { platform.telemetry('performance-tier', { tier: qualityTier, avgFps: Math.round(avg) }); } catch { /* best-effort */ }
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
    if (settings?.quality === 'auto' && !tierDroppedThisSession) applyQualityTier();
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
  try {
    settings = storage.loadSettings();
  } catch {
    settings = { ...(storage.SETTINGS_DEFAULTS || {}) };
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

  // WebGL capability + render module (decorative layer; absence is fine).
  try {
    renderMod = await import('./render.js');
    webgl = !!renderMod.isWebGLAvailable();
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
  };

  ui = createUI({ root: document.getElementById('app'), services });

  try { platform.syncTime(); } catch { /* server time falls back to Date.now() */ }

  lastFrame = performance.now();
  requestAnimationFrame(frame);

  transition('title', { owner: 'main', reason: 'boot-complete' });
}

boot();
