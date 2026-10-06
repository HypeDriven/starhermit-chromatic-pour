// ui.js — Chromatic Pour DOM layer.
// Owns every screen, the playable DOM vessel mirror (the accessibility tree
// for the board), keyboard + gamepad input, focus management, live-region
// announcements, settings, and the tutorial flow. Simulation state lives in
// GameSession; this module only renders snapshots and sends intents.

// ---------------------------------------------------------------------------
// Section 1 — small DOM/format helpers
// ---------------------------------------------------------------------------

import {
  PRESETS as GFX_PRESETS, CATEGORIES as GFX_CATEGORIES, resolve as resolveGraphics,
  presetTier, choosePreset, describe as describeGraphics, pixelRatio as gfxPixelRatio, DEFAULT_GRAPHICS,
} from './gfx.js';
import { gfxStrings, pickLocale, fmt } from './gfx-strings.js';
import { platformStrings } from './platform-strings.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

function svgUse(symbolId, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${symbolId}`);
  svg.append(use);
  return svg;
}

function fmtTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtAway(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.round(ms / 1000)} seconds`;
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function fmtScore(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function todayKey(serverNow) {
  return new Date(serverNow()).toISOString().slice(0, 10);
}

function msToNextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs;
}

// ---------------------------------------------------------------------------
// Section 2 — inline SVG shape sprite (color-blind reinforcement)
// ---------------------------------------------------------------------------
// Ten tiny shapes; liquid layers badge color index % 10 so every color also
// carries a distinct silhouette regardless of palette.

const SHAPE_IDS = Array.from({ length: 10 }, (_, i) => `cp-shape-${i}`);

function buildShapeSprite() {
  const F = 'fill="currentColor"';
  const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"';
  const shapes = [
    `<path ${F} d="M12 3C12 3 5 12 5 16a7 7 0 0 0 14 0C19 12 12 3 12 3Z"/>`,                                    // drop
    `<path ${F} d="M12 2c2 5 6 7 6 12a6 6 0 0 1-12 0C6 9 10 7 12 2Z"/>`,                                        // flame
    `<path ${F} d="M4 20C4 10 10 4 20 4c0 10-6 16-16 16Z"/><path ${S} d="M4 20C9 15 13 11 18 6"/>`,               // leaf
    `<path ${F} d="M12 2l2.5 7H22l-6 4.5L18 21l-6-4.5L6 21l2-7.5L2 9h7.5Z"/>`,                                  // star
    `<path ${F} d="M20 14A8 8 0 1 1 10 4a6.5 6.5 0 0 0 10 10Z"/>`,                                              // moon
    `<path ${S} d="M2 12c3-4 5 4 8 0s5 4 8 0"/>`,                                                               // wave
    `<path ${F} d="M12 2l8 7-8 13L4 9Z"/><path ${S} d="M4 9h16M12 2v20" opacity=".5"/>`,                        // gem
    `<path ${S} d="M12 4a8 8 0 1 0 8 8 6 6 0 1 1-6-6 4 4 0 1 0 4 4"/>`,                                         // spiral
    `<path ${F} d="M2 12c4-7 16-7 20 0-4 7-16 7-20 0Z"/><circle ${F} cx="12" cy="12" r="3" fill="var(--cp-eye-pupil,#14100e)"/>`, // eye
    `<path ${S} d="M12 2v20M6 6l6 4 6-4M6 18l6-4 6 4"/>`,                                                       // rune
  ];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cp-sprite');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = shapes
    .map((body, i) => `<symbol id="${SHAPE_IDS[i]}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  svg.append(defs);
  return svg;
}

// ---------------------------------------------------------------------------
// Section 3 — control bindings & settings defaults (UI-owned keys)
// ---------------------------------------------------------------------------

// Keyboard actions as KeyboardEvent.code lists — declared as control.<action>
// in starhermit.txt; signed in, the player's StarHermit bindings override them.
const DEFAULT_BINDINGS = {
  focusNext: ['ArrowRight', 'KeyD'],
  focusPrev: ['ArrowLeft', 'KeyA'],
  focusUp: ['ArrowUp', 'KeyW'],
  focusDown: ['ArrowDown', 'KeyS'],
  confirm: ['Enter', 'Space'],
  cancel: ['Escape'],
  pause: ['KeyP'],
  undo: ['KeyU'],
  hint: ['KeyH'],
  restart: ['KeyR'],
  cameraReset: ['KeyC'],
};

// Older saves stored one `event.key` per action ('p', 'ArrowRight', ' ').
function keyToCode(k) {
  if (typeof k !== 'string' || !k) return null;
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (k === ' ') return 'Space';
  return k;
}
function normalizeBindings(b) {
  const out = {};
  for (const [action, def] of Object.entries(DEFAULT_BINDINGS)) {
    const v = b && b[action];
    const codes = Array.isArray(v) ? v.filter((c) => typeof c === 'string' && c)
      : (typeof v === 'string' ? [keyToCode(v)].filter(Boolean) : []);
    out[action] = codes.length ? codes : def.slice();
  }
  return out;
}
const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Space: 'Space' };
function prettyCodes(codes) {
  return (codes || []).map((c) => KEY_NAMES[c] || c.replace(/^Key|^Digit/, '')).join(' / ');
}

const BINDING_LABELS = {
  focusNext: 'Focus next vessel',
  focusPrev: 'Focus previous vessel',
  focusUp: 'Focus vessel above',
  focusDown: 'Focus vessel below',
  confirm: 'Select / pour',
  cancel: 'Cancel selection',
  pause: 'Pause',
  undo: 'Undo',
  hint: 'Hint',
  restart: 'Restart round',
  cameraReset: 'Recenter view',
};

const ERROR_MESSAGES = {
  script: 'Something in the laboratory cracked. Your progress is safe — try that again.',
  promise: 'A background task failed. Your progress is safe — try that again.',
  webgl: 'The 3D shelf could not be drawn — playing in classic view.',
  audio: 'Audio could not start. The game remains fully playable in silence.',
  content: 'The level ledger failed to load. Reload to try again.',
  network: 'The host is unreachable. Ranked features are paused; local play continues.',
  storage: 'Progress could not be saved locally on this device.',
  performance: 'The shelf was struggling to keep up, so visual quality was lowered.',
};

const TERMINAL_HEADLINES = {
  'all-uniform': 'Shelf harmonized!',
  'move-limit-exceeded': 'Out of moves',
  'time-limit-exceeded': 'Time ran out',
  abandoned: 'Round abandoned',
};

// ---------------------------------------------------------------------------
// Section 4 — createUI
// ---------------------------------------------------------------------------

export function createUI({ root, services }) {
  const {
    storage, platform, audio, content, rules, GameSession,
    getRenderer, isWebGL, transition, settings, saveSettings,
  } = services;
  const mountRenderer = services.mountRenderer || (async () => null);
  const clearRenderer = services.clearRenderer || (() => {});
  const updateRenderer = services.updateRenderer || (() => {});
  const graphicsInfo = services.graphicsInfo || (() => ({ gpu: '', detected: 'balanced', webgl: isWebGL }));
  const gfxLocale = pickLocale((typeof navigator !== 'undefined' && navigator.language) || 'en-US');
  const GT = gfxStrings(gfxLocale);
  if (!settings.graphics || typeof settings.graphics !== 'object') settings.graphics = { ...DEFAULT_GRAPHICS };

  // -- live settings normalization (bindings may be absent in older saves) --
  if (settings.gamepadRemap === undefined) settings.gamepadRemap = settings.bindings?.gamepadRemap || null;
  settings.bindings = normalizeBindings(settings.bindings);
  const PT = platformStrings((typeof navigator !== 'undefined' && navigator.language) || 'en-US');
  let codeMap = null;
  function actionFor(e) {
    if (!codeMap) {
      codeMap = {};
      for (const [a, codes] of Object.entries(settings.bindings)) for (const c of codes) codeMap[c] = a;
    }
    return codeMap[e.code] || null;
  }
  // Signed in: the player's StarHermit bindings win over the local ones.
  platform.loadBindings(settings.bindings).then((b) => {
    settings.bindings = normalizeBindings(b);
    codeMap = null;
  }).catch(() => {});

  // -- module state --
  let currentState = 'boot';
  let session = null;          // active GameSession
  let levelDef = null;         // active level definition
  let modeKind = null;         // 'journey'|'daily'|'practice'|'challenge'|'score-chase'|'lesson'
  let ranked = false;
  let boardKey = null;         // leaderboard board for ranked rounds
  let scoreChaseBoard = 'global';
  let scoreChaseScope = 'global';
  let practiceSeed = freshSeed();
  let practiceDifficulty = 'apprentice';
  let inputLocked = false;
  let unlockTimer = 0;
  let roundSettling = false;
  let lastResult = null;       // payload for the results screen
  let tutorial = null;         // {lesson, stepIndex}
  let countdownTimer = 0;
  let lastFocusedBeforeOverlay = null;
  let dailyCountdownLast = '';
  let timeWarned = false;      // one-shot 'time-warning' cue per round
  let gamepadPrev = [];
  let gamepadRepeatAt = 0;

  function freshSeed() {
    return `brew-${Math.random().toString(36).slice(2, 8)}`;
  }

  function reducedMotion() {
    return !!(settings.reducedMotion ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  }

  function palette() {
    const sets = content.COLOR_SETS || {};
    return sets[settings.palette] || sets.standard || [];
  }

  function colorDef(i) {
    const p = palette();
    return p[i % Math.max(1, p.length)] || { name: `Color ${i + 1}`, hex: '#888' };
  }

  function themeDef(themeId) {
    const themes = content.THEMES || [];
    return themes.find((t) => t.id === themeId) || themes[0] || null;
  }

  function activeTheme() {
    return themeDef(levelDef && levelDef.theme) || themeDef(settings.theme);
  }

  // -------------------------------------------------------------------------
  // Section 5 — visual settings application (CSS variables + body classes)
  // -------------------------------------------------------------------------

  function applyVisualSettings() {
    const body = document.body;
    body.classList.toggle('reduced-motion', !!settings.reducedMotion);
    body.classList.toggle('high-contrast', !!settings.highContrast);
    body.classList.toggle('larger-text', !!settings.largerText);
    body.classList.toggle('left-handed', !!settings.leftHanded);
    body.classList.toggle('labels-on', !!settings.labelsOnLiquids);
    body.classList.toggle('no-webgl', !isWebGL);
    // Graphics tiers the DOM layer honours (board glass detail, ambient motion).
    const gfx = resolveGraphics(settings.graphics, graphicsInfo().detected);
    body.dataset.gfxPreset = gfx.preset;
    body.dataset.gfxDetail = gfx.detail;
    body.dataset.gfxBackground = gfx.background;

    const theme = activeTheme();
    const style = document.documentElement.style;
    if (theme) {
      if (theme.bg) style.setProperty('--theme-bg', theme.bg);
      if (theme.fog) style.setProperty('--theme-fog', theme.fog);
      if (theme.shelf) style.setProperty('--theme-shelf', theme.shelf);
      if (theme.accent) style.setProperty('--theme-accent', theme.accent);
    }
    palette().forEach((c, i) => {
      if (c && c.hex) style.setProperty(`--liquid-${i}`, c.hex);
    });
  }

  function applyAudioSettings() {
    if (!audio) return;
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      if (typeof settings[bus] === 'number') audio.setVolume(bus, settings[bus]);
    }
  }

  function persistSettings(changedKey) {
    saveSettings(settings);
    platform.telemetry('settings-change', { key: changedKey || 'unknown' });
  }

  function setSetting(key, value) {
    settings[key] = value;
    applyVisualSettings();
    applyAudioSettings();
    updateRenderer({ settings });
    persistSettings(key);
  }

  // -------------------------------------------------------------------------
  // Section 6 — shell construction
  // -------------------------------------------------------------------------

  root.textContent = '';
  root.className = 'cp-app';

  const sprite = buildShapeSprite();

  const brand = el('div', { class: 'cp-brand', text: 'Chromatic Pour' });
  const drawerLeftBtn = el('button', {
    class: 'cp-iconbtn cp-drawer-toggle cp-drawer-left', type: 'button',
    'aria-label': 'Toggle objective panel', text: '☰',
  });
  const drawerRightBtn = el('button', {
    class: 'cp-iconbtn cp-drawer-toggle cp-drawer-right', type: 'button',
    'aria-label': 'Toggle actions panel', text: '⚗',
  });
  const profileChip = el('button', { class: 'cp-profilechip', type: 'button' });
  const topbar = el('header', { class: 'cp-topbar' },
    drawerLeftBtn, brand,
    el('div', { class: 'cp-top-actions' }, drawerRightBtn, profileChip));

  const main = el('main', { class: 'cp-main', id: 'cp-main' });

  const overlayLayer = el('div', { class: 'cp-overlays' });
  const toastLayer = el('div', { class: 'cp-toasts', role: 'status', 'aria-live': 'polite' });
  const livePolite = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const liveAssertive = el('div', { class: 'sr-only', role: 'alert', 'aria-live': 'assertive' });
  const errorBanner = el('div', { class: 'cp-error-banner', role: 'alert', hidden: true });

  const shell = el('div', { class: 'cp-shell', dataset: { screen: 'title' } },
    sprite, topbar, main, overlayLayer, toastLayer, livePolite, liveAssertive, errorBanner);
  root.append(shell);

  // Screen sections (one <h1> per screen)
  const screens = {};
  for (const name of ['title', 'modes', 'setup', 'play', 'results', 'help', 'settings', 'progression']) {
    const section = el('section', { class: `screen screen-${name}`, id: `screen-${name}`, hidden: true });
    screens[name] = section;
    main.append(section);
  }

  function announce(message, assertive = false) {
    const region = assertive ? liveAssertive : livePolite;
    region.textContent = '';
    // Force re-announcement of identical consecutive messages.
    requestAnimationFrame(() => { region.textContent = message; });
  }

  async function inviteFriend() {
    audio?.play('ui');
    const ok = await platform.copyInvite();
    if (ok) notify(PT.inviteCopied);
    else notify(PT.inviteFailed);
  }

  // Renewal refused: the player is signed out; keep playing locally.
  platform.onAuth?.((a) => {
    if (a.signedIn) return;
    updateProfileChip();
    notify(PT.signedOut);
    if (currentState === 'title') buildTitleScreen();
  });

  function notify(message) {
    toast(message, 'info');
    announce(message);
  }

  function toast(message, kind = 'info') {
    const t = el('div', { class: `cp-toast cp-toast-${kind}`, text: message });
    toastLayer.append(t);
    setTimeout(() => t.classList.add('show'), 16);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }, 4200);
    while (toastLayer.children.length > 4) toastLayer.firstChild.remove();
  }

  let errorBannerTimer = 0;
  function showError(category) {
    const message = ERROR_MESSAGES[category] || ERROR_MESSAGES.script;
    errorBanner.textContent = '';
    errorBanner.append(
      el('span', { text: message }),
      el('button', {
        class: 'cp-iconbtn', type: 'button', 'aria-label': 'Dismiss', text: '×',
        onclick: () => { errorBanner.hidden = true; },
      }));
    errorBanner.hidden = false;
    announce(message, true);
    clearTimeout(errorBannerTimer);
    errorBannerTimer = setTimeout(() => { errorBanner.hidden = true; }, 8000);
  }

  function showScreen(name) {
    for (const [key, section] of Object.entries(screens)) {
      section.hidden = key !== name;
    }
    shell.dataset.screen = name;
    const section = screens[name];
    // The play screen manages its own focus (first playable vessel).
    if (name !== 'play' && section && !section.hidden) {
      const target = section.querySelector('[data-autofocus]') || section.querySelector('button, [href], input, select');
      if (target && typeof target.focus === 'function') {
        setTimeout(() => target.focus({ preventScroll: true }), 30);
      }
    }
    main.scrollTop = 0;
  }

  function updateProfileChip() {
    profileChip.textContent = '';
    const profile = platform.profile;
    if (profile && profile.displayName) {
      if (profile.avatarUrl) {
        const img = el('img', { class: 'cp-avatar', src: profile.avatarUrl, alt: '' });
        profileChip.append(img);
      }
      profileChip.append(el('span', { text: profile.displayName }));
      profileChip.setAttribute('aria-label', `Signed in as ${profile.displayName}. Account options`);
    } else {
      profileChip.append(el('span', { text: 'Guest — sign in' }));
      profileChip.setAttribute('aria-label', 'Playing as guest. Sign in');
    }
  }

  // The hosted profile can resolve after boot (short-budget lookup in
  // platform.js): refresh the chip and greet the player once it lands.
  if (typeof platform.onProfile === 'function') {
    platform.onProfile(() => {
      updateProfileChip();
      if (currentState === 'title' && platform.profile?.displayName) {
        transition('profile-ready', { owner: 'ui', reason: 'profile-resolved' });
      }
    });
  }

  profileChip.addEventListener('click', async () => {
    audio?.play('ui');
    if (platform.profile) {
      notify(`Signed in as ${platform.profile.displayName}.`);
      return;
    }
    let res = null;
    try {
      res = await platform.signIn();
    } catch { /* host shell handles its own errors */ }
    if (res?.redirecting) return; // StarHermit sign-in page; returns with a token
    updateProfileChip();
    if (platform.profile && platform.profile.displayName) {
      announce(`Signed in as ${platform.profile.displayName}.`);
      transition('profile-ready', { owner: 'ui', reason: 'sign-in' });
    } else {
      notify('Sign-in is unavailable right now — playing as guest. Progress stays on this device.');
    }
  });

  // -------------------------------------------------------------------------
  // Section 7 — TITLE screen
  // -------------------------------------------------------------------------

  let titleRefs = {};

  function buildTitleScreen() {
    const s = screens.title;
    s.textContent = '';

    const wordmark = el('h1', { class: 'cp-wordmark' },
      el('span', { class: 'cp-wordmark-a', text: 'Chromatic' }),
      el('span', { class: 'cp-wordmark-b', text: 'Pour' }));

    const playBtn = el('button', {
      class: 'btn btn-primary btn-play', type: 'button', 'data-autofocus': true,
      onclick: () => { audio?.unlock(); audio?.play('ui'); onPlay(); },
    }, el('span', { class: 'btn-play-label', text: 'Play' }),
       el('span', { class: 'btn-play-sub', text: playSubLabel() }));

    // Daily card
    const dailyDate = todayKey(platform.serverNow);
    const dailyBest = storage.loadBestScore(`daily-${dailyDate}`);
    const dailyCard = el('button', { class: 'card card-daily', type: 'button', onclick: () => openSetup('daily') },
      el('span', { class: 'card-kicker', text: 'Daily draught' }),
      el('span', { class: 'card-title', text: dailyDate }),
      el('span', { class: 'card-line', text: dailyBest
        ? `Best score ${fmtScore(dailyBest.score ?? dailyBest)}`
        : 'Not attempted yet' }),
      el('span', { class: 'card-line card-countdown', text: '' }));

    // Journey card
    const prog = storage.loadProgression();
    const stars = totalJourneyStars(prog);
    const nextStage = nextJourneyStage(prog);
    const journeyCard = el('button', { class: 'card card-journey', type: 'button', onclick: () => openSetup('journey') },
      el('span', { class: 'card-kicker', text: 'Journey' }),
      el('span', { class: 'card-title', text: `${stars} / ${(content.JOURNEY || []).length * 3} stars` }),
      el('span', { class: 'card-line', text: nextStage ? `Next: ${nextStage.name}` : 'The whole shelf glows. Mastery awaits.' }));

    const smallBtn = (label, mode) => el('button', {
      class: 'btn btn-ghost card-small', type: 'button', text: label,
      onclick: () => openSetup(mode),
    });

    const navRow = el('nav', { class: 'cp-title-nav', 'aria-label': 'More' },
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Help', onclick: () => { renderHelp(); showScreen('help'); } }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Settings', onclick: () => { renderSettings(); showScreen('settings'); } }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Progress', onclick: () => { transition('progression', { owner: 'ui', reason: 'title-nav' }); } }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'All modes', onclick: () => { transition('mode-select', { owner: 'ui', reason: 'title-nav' }); } }),
      platform.hosted ? el('button', { class: 'btn btn-ghost', type: 'button', id: 'cp-invite', text: PT.invite, onclick: () => inviteFriend() }) : null,
      platform.canSignIn?.() ? el('button', { class: 'btn btn-primary', type: 'button', id: 'cp-signin', text: PT.signIn, onclick: () => platform.signIn() }) : null);

    const titleArt = el('img', {
      class: 'cp-title-art', src: 'assets/title-art.webp', alt: '', 'aria-hidden': 'true',
      decoding: 'async', onerror: () => { titleArt.hidden = true; titleFrame.hidden = true; },
    });
    // Frame carries the 'detailed' candle-glow + rising-ember overlay (CSS only).
    const titleFrame = el('div', { class: 'cp-title-art-frame' },
      titleArt, el('span', { class: 'cp-title-embers', 'aria-hidden': 'true' }));

    s.append(
      el('div', { class: 'cp-title-hero' }, titleFrame, wordmark,
        el('p', { class: 'cp-tagline', text: 'An alchemist’s sorting ritual. Pour every hue home.' }),
        playBtn,
        !isWebGL ? el('p', { class: 'cp-nowebgl', text: '3D shelf unavailable — playing in classic view.' }) : null),
      el('div', { class: 'cp-title-cards' },
        dailyCard, journeyCard,
        smallBtn('Practice', 'practice'), smallBtn('Challenge', 'challenge'), smallBtn('Score chase', 'score-chase')),
      navRow);

    titleRefs = { dailyCountdown: dailyCard.querySelector('.card-countdown'), playBtn };
  }

  function playSubLabel() {
    const prog = storage.loadProgression();
    if (!settings.tutorialDone) return 'Begin with a lesson';
    const next = nextJourneyStage(prog);
    if (settings.lastMode && settings.lastMode !== 'journey') return `Return to ${modeTitle(settings.lastMode)}`;
    if (next) return `Continue the Journey — ${next.name}`;
    return 'Choose a mode';
  }

  function modeTitle(kind) {
    return {
      journey: 'Journey', daily: 'Daily draught', practice: 'Practice',
      challenge: 'Challenge', 'score-chase': 'Score chase', lesson: 'Learn',
    }[kind] || 'Play';
  }

  function onPlay() {
    const prog = storage.loadProgression();
    if (!settings.tutorialDone) { openSetup('lesson'); return; }
    if (settings.lastMode && settings.lastMode !== 'journey') { openSetup(settings.lastMode); return; }
    openSetup('journey');
  }

  function totalJourneyStars(prog) {
    let sum = 0;
    for (const key of Object.keys(prog.journey || {})) sum += prog.journey[key].stars || 0;
    return sum;
  }

  function nextJourneyStage(prog) {
    const journey = content.JOURNEY || [];
    return journey.find((entry) => !(prog.journey || {})[entry.id]) || null;
  }

  function tickDailyCountdown() {
    if (!titleRefs.dailyCountdown || screens.title.hidden) return;
    const ms = msToNextUtcMidnight(platform.serverNow());
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const text = `Next draught in ${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
    if (text !== dailyCountdownLast) {
      dailyCountdownLast = text;
      titleRefs.dailyCountdown.textContent = text;
    }
  }

  // -------------------------------------------------------------------------
  // Section 8 — MODE SELECT screen
  // -------------------------------------------------------------------------

  const MODE_CARDS = [
    { kind: 'lesson', name: 'Learn', rules: 'Guided lessons that teach one rule at a time — you perform each move.', duration: '~5 minutes', ranked: false, assists: 'Hints always on' },
    { kind: 'journey', name: 'Journey', rules: 'Forty authored stages of growing subtlety. Earn up to three stars each.', duration: '2–4 min per stage', ranked: false, assists: 'Undo & hints allowed' },
    { kind: 'daily', name: 'Daily draught', rules: 'One shared seed per UTC day. Same shelf for every alchemist.', duration: '~3 minutes', ranked: true, assists: 'Assists allowed, recorded' },
    { kind: 'practice', name: 'Practice', rules: 'Your difficulty, your seed. Experiment freely.', duration: 'You choose', ranked: false, assists: 'Undo & hints allowed' },
    { kind: 'challenge', name: 'Challenge', rules: 'Constrained brews: move limits, time limits, no undo.', duration: '2–5 minutes', ranked: true, assists: 'As the constraint allows' },
    { kind: 'score-chase', name: 'Score chase', rules: 'One board, endless rivalry. Climb the global or friends ladder.', duration: '~3 minutes', ranked: true, assists: 'Assists allowed, recorded' },
  ];

  function buildModeSelect() {
    const s = screens.modes;
    s.textContent = '';
    s.append(
      el('h1', { text: 'Choose your working' }),
      el('p', { class: 'screen-lede', text: 'Every mode uses the same rule: pour contiguous color layers until each vessel is empty or holds one color.' }),
      el('div', { class: 'cp-mode-grid' },
        MODE_CARDS.map((m) => el('button', {
          class: 'card card-mode', type: 'button',
          'data-autofocus': m.kind === 'journey' ? true : null,
          onclick: () => { audio?.play('ui'); openSetup(m.kind); },
        },
          el('span', { class: 'card-title', text: m.name }),
          m.ranked ? el('span', { class: 'badge badge-ranked', text: 'Ranked' }) : el('span', { class: 'badge', text: 'Unranked' }),
          el('span', { class: 'card-line', text: m.rules }),
          el('span', { class: 'card-line card-dim', text: `${m.duration} · ${m.assists}` })))),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Back to title', onclick: () => transition('title', { owner: 'ui', reason: 'modes-back' }) }));
  }

  // -------------------------------------------------------------------------
  // Section 9 — MODE SETUP screens
  // -------------------------------------------------------------------------

  function openSetup(kind) {
    audio?.unlock();
    // Reached mid-round (e.g. "Replay the lessons" from the help screen while
    // paused): the state machine has no paused → mode-select edge, so abandon
    // the old round cleanly first instead of getting stuck on the setup screen.
    if (session && (currentState === 'active' || currentState === 'paused' || currentState === 'tutorial')) {
      leaveRound();
    }
    modeKind = kind;
    if (kind !== 'lesson') {
      settings.lastMode = kind;
      saveSettings(settings);
    }
    if (currentState !== 'mode-select' && currentState !== 'preparing') {
      transition('mode-select', { owner: 'ui', reason: `setup-${kind}` });
    }
    renderSetup(kind);
    showScreen('setup');
  }

  function renderSetup(kind) {
    const s = screens.setup;
    s.textContent = '';
    const builders = {
      journey: setupJourney, practice: setupPractice, challenge: setupChallenge,
      daily: setupDaily, 'score-chase': setupScoreChase, lesson: setupLearn,
    };
    (builders[kind] || setupJourney)(s);
    s.append(el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'All modes',
      onclick: () => transition('mode-select', { owner: 'ui', reason: 'setup-back' }),
    }));
  }

  function setupHeader(s, title, lede, rankedFlag) {
    s.append(
      el('h1', { text: title }),
      el('p', { class: 'screen-lede', text: lede }),
      el('p', { class: 'cp-setup-meta' },
        rankedFlag
          ? el('span', { class: 'badge badge-ranked', text: 'Ranked — validated by replay' })
          : el('span', { class: 'badge', text: 'Unranked — no effect on ratings' })));
  }

  // -- Journey -------------------------------------------------------------
  function setupJourney(s) {
    setupHeader(s, 'The Journey', 'Forty stages of growing subtlety. Mastery stages (◆) test combined mechanics.', false);
    const prog = storage.loadProgression();
    const journey = content.JOURNEY || [];
    const firstOpen = Math.max(0, journey.findIndex((e) => !(prog.journey || {})[e.id]));
    const grid = el('div', { class: 'cp-stage-grid', role: 'list' });
    journey.forEach((entry, i) => {
      const rec = (prog.journey || {})[entry.id];
      const locked = firstOpen !== -1 && i > firstOpen;
      const stars = rec ? rec.stars || 0 : 0;
      const cell = el('button', {
        class: `stage-cell${locked ? ' locked' : ''}${entry.mastery ? ' mastery' : ''}`,
        type: 'button', role: 'listitem', disabled: locked,
        'data-autofocus': i === (firstOpen === -1 ? 0 : firstOpen) ? true : null,
        'aria-label': locked
          ? `Stage ${i + 1}, locked`
          : `Stage ${i + 1}, ${entry.name}${entry.mastery ? ', mastery' : ''}, ${stars} of 3 stars`,
        onclick: () => {
          audio?.play('ui');
          startLevel(journeyLevel(entry), { ranked: false, boardKey: null });
        },
      },
        el('span', { class: 'stage-num', text: String(i + 1) }),
        entry.mastery ? el('span', { class: 'stage-mastery', text: '◆' }) : null,
        el('span', { class: 'stage-stars', text: '★'.repeat(stars) + '☆'.repeat(3 - stars) }));
      grid.append(cell);
    });
    s.append(grid);
  }

  function journeyLevel(entry) {
    return {
      ...entry, kind: 'journey', capacity: 4, constraints: entry.constraints || {},
      contentVersion: content.CONTENT_VERSION ?? 1,
    };
  }

  // -- Practice --------------------------------------------------------------
  function setupPractice(s) {
    setupHeader(s, 'Practice bench', 'Pick a difficulty and a seed. The seed is the recipe — share it to share the exact shelf.', false);
    const diffs = content.DIFFICULTIES || [];
    const seedInput = el('input', {
      class: 'cp-seed-input', type: 'text', value: practiceSeed, maxlength: 48,
      'aria-label': 'Practice seed', spellcheck: 'false',
    });
    seedInput.addEventListener('change', () => {
      practiceSeed = seedInput.value.trim() || freshSeed();
      seedInput.value = practiceSeed;
    });
    s.append(
      el('div', { class: 'cp-diff-grid' },
        diffs.map((d) => el('button', {
          class: `card card-diff${d.id === practiceDifficulty ? ' chosen' : ''}`, type: 'button',
          'aria-pressed': d.id === practiceDifficulty ? 'true' : 'false',
          'data-autofocus': d.id === practiceDifficulty ? true : null,
          onclick: () => {
            practiceDifficulty = d.id;
            audio?.play('ui');
            s.querySelectorAll('.card-diff').forEach((c) => {
              c.classList.remove('chosen');
              c.setAttribute('aria-pressed', 'false');
            });
            // Re-mark this one.
            const cards = [...s.querySelectorAll('.card-diff')];
            const idx = diffs.findIndex((x) => x.id === d.id);
            if (cards[idx]) {
              cards[idx].classList.add('chosen');
              cards[idx].setAttribute('aria-pressed', 'true');
            }
          },
        },
          el('span', { class: 'card-title', text: d.label || d.id }),
          el('span', { class: 'card-line', text: `${d.colorCount} colors · ${d.emptyVessels} empty vessels` }),
          el('span', { class: 'card-line card-dim', text: d.desc || '' })))),
      el('div', { class: 'cp-seed-row' },
        el('label', { class: 'cp-seed-label' }, el('span', { text: 'Seed' }), seedInput),
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: 'Re-roll',
          onclick: () => { practiceSeed = freshSeed(); seedInput.value = practiceSeed; audio?.play('ui'); },
        })),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: 'Begin practice',
        onclick: () => {
          practiceSeed = seedInput.value.trim() || practiceSeed;
          startLevel(content.practiceLevel(practiceDifficulty, practiceSeed), { ranked: false, boardKey: `practice-${practiceDifficulty}` });
        },
      }));
  }

  // -- Challenge ---------------------------------------------------------------
  function setupChallenge(s) {
    setupHeader(s, 'Challenges', 'Constrained brews for exacting alchemists. Constraints are part of the leaderboard recipe.', true);
    const list = content.CHALLENGES || [];
    s.append(el('div', { class: 'cp-mode-grid' },
      list.map((c, i) => el('button', {
        class: 'card card-mode', type: 'button',
        'data-autofocus': i === 0 ? true : null,
        onclick: () => startLevel(challengeLevel(c), { ranked: true, boardKey: c.id }),
      },
        el('span', { class: 'card-title', text: c.name }),
        el('span', { class: 'card-line', text: c.desc || '' }),
        el('span', { class: 'card-line card-dim', text: constraintText(c.constraints) })))));
  }

  function challengeLevel(c) {
    return {
      ...c, kind: 'challenge', capacity: 4,
      constraints: c.constraints || {}, contentVersion: content.CONTENT_VERSION ?? 1,
    };
  }

  function constraintText(constraints = {}) {
    const parts = [];
    if (constraints.moveLimit) parts.push(`Move limit ${constraints.moveLimit}`);
    if (constraints.timeLimitMs) parts.push(`Time limit ${fmtTime(constraints.timeLimitMs)}`);
    if (constraints.noUndo) parts.push('No undo');
    return parts.length ? parts.join(' · ') : 'No special constraints';
  }

  // -- Daily ----------------------------------------------------------------------
  function setupDaily(s) {
    const date = todayKey(platform.serverNow);
    const level = content.dailyLevel(date);
    try { content.parFor(level); } catch { /* par shown once resolved */ }
    setupHeader(s, `Daily draught — ${date}`, 'One shared shelf per UTC day, synchronized to the host clock. Identical recipe for every alchemist.', true);
    const best = storage.loadBestScore(level.id);
    s.append(
      el('div', { class: 'panel' },
        el('p', { text: `${level.colorCount} colors · par ${level.parMoves} moves · ${constraintText(level.constraints)}` }),
        el('p', { class: 'card-dim', text: best ? `Your best today: ${fmtScore(best.score ?? best)}` : 'You have not attempted today’s draught.' })),
      el('button', {
        class: 'btn btn-primary', type: 'button', 'data-autofocus': true, text: 'Pour today’s draught',
        onclick: () => startLevel({ ...level, kind: 'daily' }, { ranked: true, boardKey: level.id }),
      }));
  }

  // -- Score chase ------------------------------------------------------------------
  function setupScoreChase(s) {
    setupHeader(s, 'Score chase', 'One board, endless rivalry. Boards marked daily rotate at UTC midnight; the evergreen board never changes.', true);
    // Board keys are the level ids themselves — the authoritative API requires
    // board === levelId and re-simulates the seeded board server-side.
    const chaseDailySeed = `chase-${todayKey(platform.serverNow)}`;
    const boards = [
      { key: `practice-master-${chaseDailySeed}`, scope: 'global', label: 'Global daily', seed: chaseDailySeed },
      { key: 'practice-master-chase-evergreen', scope: 'global', label: 'Global all-time', seed: 'chase-evergreen' },
      { key: 'practice-master-chase-evergreen', scope: 'friends', label: 'Friends', seed: 'chase-evergreen' },
    ];
    const tableWrap = el('div', { class: 'cp-leaderboard' });
    const bestLine = el('p', { class: 'card-dim' });

    async function refreshBoard(board) {
      scoreChaseBoard = board.key;
      scoreChaseScope = board.scope;
      tableWrap.textContent = '';
      tableWrap.append(el('p', { class: 'card-dim', text: 'Consulting the ledger…' }));
      let entries;
      try {
        entries = await platform.fetchLeaderboard(board.key, board.scope);
      } catch {
        entries = { error: 'network' };
      }
      tableWrap.textContent = '';
      if (!Array.isArray(entries)) {
        tableWrap.append(el('p', { class: 'card-dim', text: 'The ledger is unreachable — ranked submission resumes when the host responds.' }));
      } else if (!entries.length) {
        tableWrap.append(el('p', { class: 'card-dim', text: 'No scores yet. The first name on this board could be yours.' }));
      } else {
        tableWrap.append(el('table', { class: 'cp-table' },
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col', text: '#' }), el('th', { scope: 'col', text: 'Alchemist' }), el('th', { scope: 'col', text: 'Score' }))),
          el('tbody', {}, entries.slice(0, 10).map((e, i) => el('tr', {},
            el('td', { text: String(i + 1) }),
            el('td', { text: e.displayName || e.name || 'Alchemist' }),
            el('td', { text: fmtScore(e.score ?? 0) }))))));
      }
      const best = storage.loadBestScore(board.key);
      bestLine.textContent = best ? `Your best on this board: ${fmtScore(best.score ?? best)}` : 'No local best on this board yet.';
    }

    s.append(
      el('div', { class: 'cp-board-picker', role: 'group', 'aria-label': 'Leaderboard' },
        boards.map((b) => el('button', {
          class: 'btn btn-ghost', type: 'button', text: b.label,
          onclick: () => { audio?.play('ui'); refreshBoard(b); },
        }))),
      tableWrap, bestLine,
      el('button', {
        class: 'btn btn-primary', type: 'button', 'data-autofocus': true, text: 'Chase the score',
        onclick: () => {
          const b = boards.find((x) => x.key === scoreChaseBoard && x.scope === scoreChaseScope) || boards[1];
          const level = content.practiceLevel('master', b.seed);
          startLevel({ ...level, name: b.label }, { ranked: true, boardKey: b.key, scoreChase: true });
        },
      }));
    refreshBoard(boards[0]);
  }

  // -- Learn -------------------------------------------------------------------------
  function setupLearn(s) {
    setupHeader(s, 'Lessons', 'Short guided brews. Each lesson asks you to perform the rule yourself.', false);
    const lessons = content.LESSONS || [];
    if (settings.tutorialDone) {
      s.append(el('p', { class: 'card-dim', text: 'All lessons completed. Replay any time — the shelf is patient.' }));
    }
    s.append(el('div', { class: 'cp-mode-grid' },
      lessons.map((lesson, i) => el('button', {
        class: 'card card-mode', type: 'button',
        'data-autofocus': i === 0 ? true : null,
        onclick: () => {
          tutorial = { lesson, stepIndex: 0 };
          const step = lesson.steps[0];
          startLevel(lessonLevel(lesson, step, 0), { ranked: false, boardKey: null, tutorial: true });
        },
      },
        el('span', { class: 'card-title', text: lesson.title || `Lesson ${i + 1}` }),
        el('span', { class: 'card-line', text: `${lesson.steps.length} step${lesson.steps.length === 1 ? '' : 's'}` })))));
  }

  function lessonLevel(lesson, step, index) {
    const setup = step.setup || {};
    return {
      id: `lesson-${lesson.id || 'x'}-${index}`,
      name: lesson.title || 'Lesson',
      kind: 'lesson',
      seed: setup.seed ?? `lesson-${lesson.id || 'x'}-${index}`,
      colorCount: setup.colorCount ?? 3,
      capacity: 4,
      emptyVessels: setup.emptyVessels ?? 1,
      vessels: setup.vessels || undefined,
      constraints: {},
      parMoves: 0,
      theme: undefined,
      contentVersion: content.CONTENT_VERSION ?? 1,
    };
  }

  // -------------------------------------------------------------------------
  // Section 10 — level start, preparing, countdown
  // -------------------------------------------------------------------------

  function startLevel(level, { ranked: isRanked, boardKey: board, tutorial: isTutorial = false }) {
    clearRendererAndCanvas();
    levelDef = level;
    ranked = !!isRanked;
    boardKey = board || null;
    roundSettling = false;
    lastResult = null;
    inputLocked = false;
    timeWarned = false;
    try {
      session = new GameSession(level, { now: () => Date.now() });
    } catch (err) {
      console.error('Failed to create session', err);
      showError('content');
      session = null;
      return;
    }
    if (!isTutorial) tutorial = null;
    // Resolve par (solver depth + slack) before the HUD/scoring need it.
    // Cached inside content after the first solve; lessons skip par entirely.
    if (levelDef.kind !== 'lesson' && !Number.isInteger(levelDef.parMoves)) {
      try { content.parFor(levelDef); } catch { /* scoring falls back to a default par */ }
    }
    settings.lastMode = modeKind === 'lesson' ? settings.lastMode : modeKind;
    saveSettings(settings);
    platform.telemetry('start', { kind: level.kind, id: level.id });
    buildPlayScreen();
    transition('preparing', { owner: 'ui', reason: `start-${level.kind}` });
  }

  function clearRendererAndCanvas() {
    const r = getRenderer();
    if (r) {
      try { r.dispose(); } catch { /* renderer teardown is best-effort */ }
    }
    clearRenderer();
    canvasMounted = false; // the canvas element is rebuilt with the play screen
  }

  function onPreparing() {
    showScreen('play');
    applyVisualSettings();
    // Render the not-yet-started board so the shelf is never blank.
    try {
      const initial = content.buildLevelState(levelDef);
      renderBoard(initial);
    } catch { /* buildLevelState mirrors session's own initial state */ }
    mountPlayCanvas().then(() => {
      if (tutorial) {
        transition('tutorial', { owner: 'ui', reason: 'lesson' });
      } else {
        transition('countdown', { owner: 'ui', reason: 'level-ready' });
      }
    });
  }

  let canvasMounted = false;
  async function mountPlayCanvas() {
    if (canvasMounted || !isWebGL) return;
    canvasMounted = true;
    const host = playRefs.canvasHost;
    if (!host) return;
    const canvas = el('canvas', { class: 'cp-canvas', 'aria-hidden': 'true' });
    host.append(canvas);
    const r = await mountRenderer({
      canvas,
      container: host,
      theme: activeTheme(),
      paletteColors: palette(),
      onVesselPick: (i) => onVesselActivate(i),
    });
    if (!r) {
      canvas.remove();
      notify(ERROR_MESSAGES.webgl);
    }
  }

  function onCountdown() {
    showScreen('play');
    const steps = reducedMotion() ? ['Go'] : ['3', '2', '1', 'Go'];
    const overlay = el('div', { class: 'cp-countdown', role: 'status', 'aria-live': 'assertive' });
    overlayLayer.append(overlay);
    let i = 0;
    const stepMs = reducedMotion() ? 500 : 700;
    const advance = () => {
      if (currentState !== 'countdown') { overlay.remove(); return; }
      if (i >= steps.length) {
        overlay.remove();
        beginActiveRound();
        return;
      }
      overlay.textContent = steps[i];
      overlay.classList.remove('pop');
      // Restart the pop animation.
      void overlay.offsetWidth;
      overlay.classList.add('pop');
      announce(steps[i] === 'Go' ? 'Go!' : steps[i]);
      audio?.play(steps[i] === 'Go' ? 'ui' : 'tick');
      i += 1;
      countdownTimer = setTimeout(advance, stepMs);
    };
    advance();
  }

  function beginActiveRound() {
    clearTimeout(countdownTimer);
    if (!session) return;
    const state = session.start();
    renderBoard(state);
    const r = getRenderer();
    if (r) {
      try { r.setState(state); } catch { /* decorative layer is best-effort */ }
    }
    const theme = activeTheme();
    if (audio && theme) audio.startAmbience(theme.id);
    transition('active', { owner: 'ui', reason: tutorial ? 'lesson-step' : 'countdown-done' });
  }

  function onActive() {
    showScreen('play');
    closePauseOverlay();
    hideTutorialCardIfNotTutorial();
    updateHud();
    if (session && session.state) renderBoard(session.state);
    focusVesselButton(firstPlayableVessel());
  }

  function firstPlayableVessel() {
    const state = session?.state;
    if (!state) return 0;
    const idx = state.vessels.findIndex((v) => v.length > 0);
    return idx === -1 ? 0 : idx;
  }

  // -------------------------------------------------------------------------
  // Section 11 — PLAY screen: HUD, rails, tray, board mirror
  // -------------------------------------------------------------------------

  let playRefs = {};
  let built = { play: false };

  function buildPlayScreen() {
    const s = screens.play;
    s.textContent = '';
    built.play = true;

    const objectiveEl = el('p', { class: 'cp-objective', text: '' });
    const progressEl = el('p', { class: 'cp-progress', text: '' });
    const timerEl = el('p', { class: 'cp-timer', text: '0:00' });
    const movesEl = el('p', { class: 'cp-moves', text: '0 moves' });
    const limitBadge = el('p', { class: 'cp-limit-badge', text: '', hidden: true });

    const undoBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Undo', onclick: () => doUndo() });
    const hintBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Hint', onclick: () => doHint() });
    const restartBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Restart', onclick: () => doRestart() });
    const pauseBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Pause', onclick: () => pauseRound() });
    const skipBtn = el('button', {
      class: 'btn btn-primary cp-skip', type: 'button', text: 'Skip animation', hidden: true,
      onclick: () => skipPour(),
    });

    const leftRail = el('aside', { class: 'rail rail-left', 'aria-label': 'Objective and progress' },
      el('h2', { class: 'rail-title', text: 'Working' }),
      objectiveEl, progressEl, limitBadge,
      el('p', { class: 'card-dim cp-levelname', text: levelDef?.name || '' }));

    const rightRail = el('aside', { class: 'rail rail-right', 'aria-label': 'Actions and status' },
      el('h2', { class: 'rail-title', text: 'Actions' }),
      undoBtn, hintBtn, restartBtn, pauseBtn,
      el('div', { class: 'rail-status' }, timerEl, movesEl));

    const boardEl = el('div', {
      class: 'cp-board', role: 'group', 'aria-label': 'Vessels on the shelf',
    });
    const canvasHost = el('div', { class: 'cp-canvas-host', 'aria-hidden': 'true' });
    const playfield = el('div', { class: 'cp-playfield' }, canvasHost, boardEl, skipBtn);

    // Compact status strip: the objective / moves / timer that the rails
    // carry on wide layouts, always visible on small screens.
    const stripObjective = el('span', { class: 'cp-strip-objective', text: '' });
    const stripMoves = el('span', { class: 'cp-strip-moves', text: '0 moves' });
    const stripTimer = el('span', { class: 'cp-strip-timer', text: '0:00' });
    const stripLimit = el('span', { class: 'cp-strip-limit', text: '', hidden: true });
    const statusStrip = el('div', { class: 'cp-status-strip', role: 'status', 'aria-live': 'off' },
      stripObjective, stripMoves, stripTimer, stripLimit);

    const tray = el('nav', { class: 'cp-tray', 'aria-label': 'Round actions' });
    // Tray clones mirror rail buttons so thumb-zone targets stay in sync.
    const trayUndo = cloneAction(undoBtn);
    const trayHint = cloneAction(hintBtn);
    const trayPause = cloneAction(pauseBtn);
    const trayRestart = cloneAction(restartBtn);
    tray.append(trayUndo, trayHint, trayPause, trayRestart);

    s.append(
      el('h1', { class: 'sr-only', text: 'Playfield' }),
      statusStrip,
      el('div', { class: 'cp-play-layout' }, leftRail, playfield, rightRail),
      tray);

    playRefs = {
      objectiveEl, progressEl, timerEl, movesEl, limitBadge,
      stripObjective, stripMoves, stripTimer, stripLimit,
      undoBtn, hintBtn, restartBtn, pauseBtn, skipBtn,
      trayUndo, trayHint, trayPause, trayRestart,
      leftRail, rightRail, boardEl, canvasHost, playfield,
    };

    drawerLeftBtn.onclick = () => { leftRail.classList.toggle('open'); rightRail.classList.remove('open'); };
    drawerRightBtn.onclick = () => { rightRail.classList.toggle('open'); leftRail.classList.remove('open'); };
  }

  function cloneAction(btn) {
    const clone = el('button', {
      class: 'btn btn-ghost tray-btn', type: 'button', text: btn.textContent,
      'aria-label': btn.textContent,
      onclick: () => btn.click(),
    });
    btn._trayClone = clone;
    return clone;
  }

  function syncActionStates() {
    if (!playRefs.undoBtn) return;
    const canUndo = !!(session && session.canUndo) && !inputLocked;
    for (const b of [playRefs.undoBtn, playRefs.trayUndo]) {
      if (!b) continue;
      b.disabled = !canUndo;
      b.setAttribute('aria-disabled', canUndo ? 'false' : 'true');
      b.title = levelDef?.constraints?.noUndo ? 'This challenge forbids undo.' : '';
    }
    const hintsOn = !!settings.hintsEnabled;
    for (const b of [playRefs.hintBtn, playRefs.trayHint]) {
      if (!b) continue;
      b.hidden = !hintsOn;
    }
  }

  function updateHud() {
    if (!playRefs.objectiveEl || !levelDef) return;
    const state = session?.state;
    playRefs.objectiveEl.textContent = `Unify every vessel — ${levelDef.colorCount} colors`;
    if (state) {
      const done = state.vessels.filter((v, i) => rules.isVesselComplete(state, i)).length;
      playRefs.progressEl.textContent = `Harmonized ${done} of ${state.vessels.length} vessels`;
      playRefs.movesEl.textContent = `${state.moves} move${state.moves === 1 ? '' : 's'}`;
      playRefs.stripObjective.textContent = `${done}/${state.vessels.length} unified`;
      playRefs.stripMoves.textContent = playRefs.movesEl.textContent;
      const c = state.constraints || {};
      if (c.moveLimit) {
        playRefs.limitBadge.hidden = false;
        playRefs.limitBadge.textContent = `Moves ${state.moves} / ${c.moveLimit}`;
        playRefs.limitBadge.classList.toggle('danger', state.moves >= c.moveLimit - 3);
      } else if (c.timeLimitMs) {
        playRefs.limitBadge.hidden = false;
        playRefs.limitBadge.textContent = `Time limit ${fmtTime(c.timeLimitMs)}`;
      } else {
        playRefs.limitBadge.hidden = true;
      }
      playRefs.stripLimit.hidden = playRefs.limitBadge.hidden;
      playRefs.stripLimit.textContent = playRefs.limitBadge.textContent;
      playRefs.stripLimit.classList.toggle('danger', playRefs.limitBadge.classList.contains('danger'));
    }
    syncActionStates();
    if (audio && state) {
      const done = state.vessels.filter((v, i) => rules.isVesselComplete(state, i)).length;
      audio.setMusicIntensity(state.vessels.length ? done / state.vessels.length : 0);
    }
  }

  function updateTimer() {
    if (!playRefs.timerEl || !session) return;
    const state = session.state;
    if (!state) return;
    const elapsed = session.elapsedMs();
    const limit = state.constraints?.timeLimitMs;
    if (limit) {
      const remaining = limit - elapsed;
      playRefs.timerEl.textContent = `−${fmtTime(Math.max(0, remaining))}`;
      playRefs.timerEl.classList.toggle('danger', remaining < 15000);
      playRefs.stripTimer.textContent = playRefs.timerEl.textContent;
      playRefs.stripTimer.classList.toggle('danger', remaining < 15000);
      if (!timeWarned && remaining < 15000 && remaining > 0 && state.status === 'active' && currentState === 'active') {
        timeWarned = true;
        audio?.play('time-warning');
        announce('Fifteen seconds left.', true);
      }
    } else {
      playRefs.timerEl.textContent = fmtTime(elapsed);
      playRefs.timerEl.classList.remove('danger');
      playRefs.stripTimer.textContent = playRefs.timerEl.textContent;
      playRefs.stripTimer.classList.remove('danger');
    }
  }

  // -------------------------------------------------------------------------
  // Section 12 — DOM board mirror (the playable, accessible board)
  // -------------------------------------------------------------------------

  function boardState() {
    return session ? session.state : null;
  }

  function vesselAriaLabel(state, i) {
    const v = state.vessels[i];
    if (!v.length) return `Vessel ${i + 1}: empty`;
    const top = colorDef(v[v.length - 1]);
    let label = `Vessel ${i + 1}: ${v.length} layer${v.length === 1 ? '' : 's'}, top ${top.name}`;
    if (v.every((c) => c === v[0])) {
      label += v.length === state.capacity ? ', harmonized' : ', single color';
    }
    return label;
  }

  function renderBoard(stateOverride) {
    const state = stateOverride || boardState();
    const boardEl = playRefs.boardEl;
    if (!state || !boardEl) return;
    boardEl.textContent = '';
    boardEl.style.setProperty('--capacity', state.capacity);
    const roundOver = state.status !== 'active';
    const selected = session ? session.selected : null;

    state.vessels.forEach((layers, i) => {
      const btn = el('button', {
        class: 'vessel', type: 'button', dataset: { index: String(i) },
        'aria-label': vesselAriaLabel(state, i),
        'aria-pressed': selected === i ? 'true' : 'false',
        disabled: roundOver,
      });
      if (selected === i) btn.classList.add('selected');

      const tube = el('span', { class: 'vessel-tube', 'aria-hidden': 'true' });
      // Bottom-first layers; CSS column-reverse paints index 0 at the base.
      for (let slot = 0; slot < state.capacity; slot++) {
        const color = layers[slot];
        if (color == null) {
          tube.append(el('span', { class: 'layer slot-empty' }));
        } else {
          const def = colorDef(color);
          const layer = el('span', {
            class: 'layer', dataset: { color: String(color) },
            style: `--c:${def.hex || `var(--liquid-${color % 10})`}`,
          },
            svgUse(SHAPE_IDS[color % SHAPE_IDS.length], 'layer-shape'),
            el('span', { class: 'layer-label', text: def.name || `Color ${color + 1}` }));
          tube.append(layer);
        }
      }
      btn.append(tube, el('span', { class: 'vessel-num', 'aria-hidden': 'true', text: String(i + 1) }));

      btn.addEventListener('click', (e) => onVesselActivate(i, e));
      btn.addEventListener('focus', () => {
        const r = getRenderer();
        if (r) { try { r.focusVessel(i); } catch { /* decorative */ } }
      });
      boardEl.append(btn);
    });
    markLegalTargets();
    syncActionStates();
  }

  function markLegalTargets() {
    const boardEl = playRefs.boardEl;
    if (!boardEl || !session) return;
    const state = session.state;
    const selected = session.selected;
    const buttons = boardEl.querySelectorAll('.vessel');
    buttons.forEach((b) => b.classList.remove('target-ok'));
    if (selected == null || !state || state.status !== 'active') return;
    const targets = rules.legalPours(state, { includePointless: true })
      .filter((p) => p.from === selected)
      .map((p) => p.to);
    for (const to of targets) {
      buttons[to]?.classList.add('target-ok');
    }
  }

  function focusVesselButton(i) {
    const btn = playRefs.boardEl?.querySelector(`.vessel[data-index="${i}"]`);
    if (btn && !btn.disabled) btn.focus({ preventScroll: true });
  }

  function vesselButtons() {
    return [...(playRefs.boardEl?.querySelectorAll('.vessel') || [])];
  }

  // -- selection / pour intent ----------------------------------------------

  let holdTimer = 0;

  function onVesselActivate(i, evt) {
    if (inputLocked || !session || currentState === 'paused') return;
    if (settings.holdToConfirm && evt && evt.detail > 0) {
      // Hold-to-confirm: plain pointer clicks are ignored — the press-and-hold
      // timer below commits the action instead. Keyboard clicks (detail 0)
      // pass through. (The click that trails a completed hold is swallowed
      // here too, so a hold can never select-then-deselect.)
      return;
    }
    audio?.unlock();
    if (tutorial) {
      tutorialVesselIntent(i);
      return;
    }
    const res = session.selectVessel(i);
    handleSelectResult(res);
  }

  function handleSelectResult(res) {
    const r = getRenderer();
    if (res.kind === 'selected') {
      const state = session.state;
      const run = rules.topRun(state, res.index);
      const def = run ? colorDef(run.color) : null;
      audio?.play('select');
      announce(`Vessel ${res.index + 1} selected${def ? `, ${def.name}, ${run.layers} layer${run.layers === 1 ? '' : 's'}` : ''}.`);
      renderBoard();
      if (r) {
        try { r.setSelected(res.index); r.previewTargets(res.index); } catch { /* decorative */ }
      }
      return;
    }
    if (res.kind === 'deselected') {
      audio?.play('deselect');
      announce('Selection cleared.');
      renderBoard();
      if (r) { try { r.setSelected(null); r.previewTargets(null); } catch { /* decorative */ } }
      return;
    }
    if (res.kind === 'pour') {
      doPour(res.events, res.from, res.to);
      return;
    }
    // error
    const idx = res.index ?? session.selected ?? 0;
    audio?.play('invalid');
    showInvalidOnVessel(idx, res.message || 'That pour is not allowed.');
    if (res.reselected) {
      renderBoard();
      if (r) { try { r.setSelected(idx); r.previewTargets(idx); } catch { /* decorative */ } }
    }
  }

  function showInvalidOnVessel(i, message) {
    announce(message, true);
    const btn = playRefs.boardEl?.querySelector(`.vessel[data-index="${i}"]`);
    if (btn && !reducedMotion()) {
      btn.classList.remove('invalid');
      void btn.offsetWidth;
      btn.classList.add('invalid');
      btn.addEventListener('animationend', () => btn.classList.remove('invalid'), { once: true });
    } else if (btn) {
      btn.classList.add('invalid');
      setTimeout(() => btn.classList.remove('invalid'), 350);
    }
    const r = getRenderer();
    if (r) { try { r.showInvalid(i, 'invalid'); } catch { /* decorative */ } }
  }

  // -- pour choreography --------------------------------------------------------

  function doPour(events, from, to) {
    const pourEvt = (events || []).find((e) => e.type === 'pour');
    const terminal = (events || []).find((e) => e.type === 'complete' || e.type === 'failed');
    const def = pourEvt ? colorDef(pourEvt.color) : null;

    inputLocked = true;
    playRefs.skipBtn.hidden = false;
    audio?.play('pour-start');

    // State is already applied inside the session; re-render to the final
    // snapshot, then dress the transition with cosmetic classes.
    renderBoard();
    updateHud();

    const motion = !reducedMotion();
    const srcBtn = playRefs.boardEl?.querySelector(`.vessel[data-index="${from}"]`);
    const dstBtn = playRefs.boardEl?.querySelector(`.vessel[data-index="${to}"]`);
    if (motion && pourEvt) {
      srcBtn?.classList.add('lifting');
      dstBtn?.classList.add('receiving');
      const layers = dstBtn?.querySelectorAll('.layer:not(.slot-empty)') || [];
      const fresh = [...layers].slice(-pourEvt.layers);
      fresh.forEach((layer, k) => {
        layer.classList.add('layer-new');
        layer.style.animationDelay = `${k * 70}ms`;
      });
    }

    if (pourEvt && def) {
      announce(`Poured ${pourEvt.layers} layer${pourEvt.layers === 1 ? '' : 's'} of ${def.name} from Vessel ${from + 1} to Vessel ${to + 1}.`);
    }

    const r = getRenderer();
    if (r) {
      try { r.setState(session.state, events); r.setSelected(null); r.playEvents(events); } catch { /* decorative */ }
    }

    // A vessel that just became full and uniform earns its own chime; the
    // terminal win/fail cue covers the last pour of a round.
    const stateAfter = session.state;
    const harmonized = !!(pourEvt && !terminal && stateAfter &&
      stateAfter.vessels[to].length === stateAfter.capacity && rules.isVesselComplete(stateAfter, to));

    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => {
      settlePour(srcBtn, dstBtn);
      if (harmonized) audio?.play('layer-complete');
      // In lessons the tutorial flow owns advancement; rounds never "end".
      if (terminal && !tutorial) {
        endRound(terminal);
      }
    }, motion ? 560 : 0);
  }

  function settlePour(srcBtn, dstBtn) {
    clearTimeout(unlockTimer);
    inputLocked = false;
    playRefs.skipBtn.hidden = true;
    srcBtn?.classList.remove('lifting');
    dstBtn?.classList.remove('receiving');
    playRefs.boardEl?.querySelectorAll('.layer-new').forEach((n) => {
      n.classList.remove('layer-new');
      n.style.animationDelay = '';
    });
    audio?.play('pour-end');
    syncActionStates();
  }

  function skipPour() {
    if (!inputLocked) return;
    const r = getRenderer();
    if (r) { try { r.skip(); } catch { /* decorative */ } }
    settlePour();
    // A terminal event may be waiting behind the animation timer.
    const state = session?.state;
    if (state && state.status !== 'active' && !roundSettling && !tutorial) {
      endRound({ type: state.status === 'complete' ? 'complete' : 'failed', reason: state.terminalReason });
    }
  }

  // -- undo / hint / restart ---------------------------------------------------

  function doUndo() {
    if (inputLocked || !session) return;
    if (tutorial && !tutorialGate('undo')) return;
    const ok = session.undo();
    if (ok) {
      audio?.play('undo');
      renderBoard();
      updateHud();
      const r = getRenderer();
      if (r) { try { r.setState(session.state); r.setSelected(null); } catch { /* decorative */ } }
      announce('Last pour undone.');
      if (tutorial) advanceTutorial();
    } else {
      announce(levelDef?.constraints?.noUndo ? 'This challenge forbids undo.' : 'Nothing to undo yet.', true);
      audio?.play('invalid');
    }
  }

  function doHint() {
    if (inputLocked || !session || !settings.hintsEnabled) return;
    const h = session.hint();
    if (!h) {
      announce('No helpful pour found — the shelf may already be settled.', true);
      return;
    }
    audio?.play('hint');
    renderBoard();
    const buttons = vesselButtons();
    buttons[h.from]?.classList.add('hint-from');
    buttons[h.to]?.classList.add('hint-target');
    const def = colorDef(h.color);
    announce(`The ledger suggests: pour ${def.name} from Vessel ${h.from + 1} to Vessel ${h.to + 1}.`);
    setTimeout(() => {
      buttons[h.from]?.classList.remove('hint-from');
      buttons[h.to]?.classList.remove('hint-target');
    }, 2400);
  }

  function doRestart() {
    if (inputLocked || !session) return;
    if (tutorial && !tutorialGate('restart')) return;
    session.restart();
    timeWarned = false;
    audio?.play('ui');
    renderBoard();
    updateHud();
    const r = getRenderer();
    if (r) { try { r.setState(session.state); r.setSelected(null); } catch { /* decorative */ } }
    announce('Round restarted — same recipe, fresh shelf.');
    if (tutorial) advanceTutorial();
  }

  // -------------------------------------------------------------------------
  // Section 13 — pause overlay, focus trap, confirm dialog
  // -------------------------------------------------------------------------

  let pauseOverlay = null;
  let pauseKeyHandler = null;

  function pauseRound() {
    if (!session || currentState !== 'active') return;
    transition('paused', { owner: 'ui', reason: 'pause-request' });
  }

  function onPaused() {
    session?.pause();
    const r = getRenderer();
    if (r) { try { r.setPaused(true); } catch { /* decorative */ } }
    showPauseOverlay();
  }

  function showPauseOverlay() {
    lastFocusedBeforeOverlay = document.activeElement;
    const resumeBtn = el('button', {
      class: 'btn btn-primary', type: 'button', 'data-autofocus': true, text: 'Resume',
      onclick: () => resumeRound(),
    });
    const restartBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Restart round', onclick: () => { resumeRound(); doRestart(); } });
    const settingsBtn = el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Settings',
      onclick: () => { renderSettings(); showScreen('settings'); closePauseOverlay(); transition('paused', { owner: 'ui', reason: 'pause-settings' }); },
    });
    const helpBtn = el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Help',
      onclick: () => { renderHelp(); showScreen('help'); closePauseOverlay(); },
    });
    const leaveBtn = el('button', { class: 'btn btn-danger', type: 'button', text: 'Leave to title', onclick: () => leaveRound() });

    pauseOverlay = el('div', { class: 'cp-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pause-title' },
      el('div', { class: 'panel cp-pause-panel' },
        el('h2', { id: 'pause-title', text: 'Paused — the alembic rests' }),
        el('div', { class: 'cp-pause-group' }, resumeBtn),
        el('div', { class: 'cp-pause-group' }, restartBtn, settingsBtn, helpBtn),
        el('div', { class: 'cp-pause-group' }, leaveBtn)));
    overlayLayer.append(pauseOverlay);

    pauseKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resumeRound();
        return;
      }
      if (e.key === 'Tab') trapFocus(e, pauseOverlay);
    };
    document.addEventListener('keydown', pauseKeyHandler, true);
    setTimeout(() => resumeBtn.focus(), 30);
  }

  function closePauseOverlay() {
    if (pauseKeyHandler) document.removeEventListener('keydown', pauseKeyHandler, true);
    pauseKeyHandler = null;
    pauseOverlay?.remove();
    pauseOverlay = null;
  }

  function resumeRound() {
    closePauseOverlay();
    session?.resume();
    const r = getRenderer();
    if (r) { try { r.setPaused(false); } catch { /* decorative */ } }
    transition('active', { owner: 'ui', reason: 'resume' });
    restoreFocus();
  }

  function leaveRound() {
    closePauseOverlay();
    audio?.stopAmbience();
    const r = getRenderer();
    if (r) { try { r.setPaused(false); } catch { /* decorative */ } }
    platform.telemetry('round-end', { kind: levelDef?.kind, quit: true });
    session = null;
    levelDef = null;
    tutorial = null;
    buildTitleScreen();
    transition('title', { owner: 'ui', reason: 'leave-round' });
  }

  function restoreFocus() {
    const target = lastFocusedBeforeOverlay;
    lastFocusedBeforeOverlay = null;
    if (target && document.contains(target) && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  function trapFocus(e, container) {
    const focusables = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Promise-based confirm dialog (double confirms, import conflicts).
  function confirmDialog(title, body, confirmLabel = 'Confirm') {
    return new Promise((resolve) => {
      lastFocusedBeforeOverlay = document.activeElement;
      const done = (value) => {
        document.removeEventListener('keydown', onKey, true);
        dialog.remove();
        restoreFocus();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        if (e.key === 'Tab') trapFocus(e, dialog);
      };
      const dialog = el('div', { class: 'cp-overlay', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'panel cp-confirm-panel' },
          el('h2', { text: title }),
          el('p', { text: body }),
          el('div', { class: 'cp-pause-group' },
            el('button', { class: 'btn btn-danger', type: 'button', text: confirmLabel, onclick: () => done(true) }),
            el('button', { class: 'btn btn-ghost', type: 'button', 'data-autofocus': true, text: 'Cancel', onclick: () => done(false) }))));
      document.addEventListener('keydown', onKey, true);
      overlayLayer.append(dialog);
      setTimeout(() => dialog.querySelector('[data-autofocus]')?.focus(), 30);
    });
  }

  // -------------------------------------------------------------------------
  // Section 14 — round end, results
  // -------------------------------------------------------------------------

  async function endRound(terminalEvt) {
    if (roundSettling || !session) return;
    roundSettling = true;
    inputLocked = true;
    playRefs.skipBtn.hidden = true;
    const reason = terminalEvt.reason || (terminalEvt.type === 'complete' ? 'all-uniform' : null);
    transition('resolving', { owner: 'ui', reason: reason || 'round-over' });

    const complete = terminalEvt.type === 'complete';
    audio?.play(complete ? 'win' : 'fail');
    const r = getRenderer();
    if (r) {
      try { await r.playEvents([terminalEvt]); } catch { /* decorative */ }
    }

    const result = session.result();
    const env = session.replayEnvelope();
    let record = { progression: storage.loadProgression(), newAchievements: [], stars: 0 };
    try {
      record = storage.recordResult(levelDef, result);
    } catch {
      showError('storage');
    }
    if ((record.newAchievements || []).length) audio?.play('achievement');
    for (const key of record.newAchievements || []) {
      const meta = (storage.ACHIEVEMENTS || []).find((a) => a.key === key);
      // the results screen lists new unlocks under "Achievements unlocked";
      // a toast here would sit over that list and the results buttons
      announce(`Achievement unlocked: ${meta ? meta.name : key}`);
      // Durable delivery to the host (idempotent server-side); local unlock
      // already happened in recordResult.
      try { platform.unlockAchievement?.(key)?.catch?.(() => {}); } catch { /* best-effort */ }
    }

    // Personal-best comparison (before this round is written).
    let bestBefore = null;
    if (boardKey) {
      try { bestBefore = storage.loadBestScore(boardKey); } catch { bestBefore = null; }
    }

    // Ranked submission with the replay envelope for server-side validation.
    // Only completed rounds are submitted: the authoritative API replays the
    // command log and requires a terminal 'complete' state, so a failed round
    // would be rejected (and would surface a misleading network error).
    let submission = null;
    if (ranked && boardKey) {
      try { storage.saveReplayEnvelope(env); } catch { /* replay archive is best-effort */ }
    }
    if (ranked && boardKey && result.complete) {
      const entry = {
        levelId: levelDef.id,
        seed: levelDef.seed,
        contentVersion: levelDef.contentVersion ?? 1,
        name: platform.profile?.displayName || undefined,
        sessionId: result.sessionId,
        result: {
          score: result.score.total,
          moves: result.moves,
          invalidActions: result.invalidActions,
          elapsedMs: result.elapsedMs,
          assists: result.assists,
          sessionId: result.sessionId,
        },
        replay: env,
      };
      try {
        submission = await platform.submitScore(boardKey, entry);
      } catch {
        submission = { error: 'network' };
      }
      if (submission && submission.accepted) {
        try { storage.saveBestScore(boardKey, { score: result.score.total, moves: result.moves, ms: result.elapsedMs }); } catch { /* best-effort */ }
      } else if (submission && submission.error) {
        showError('network');
      }
    } else if (boardKey && result.complete) {
      // Unranked boards still track a local best for comparison.
      try {
        const prev = storage.loadBestScore(boardKey);
        if (!prev || result.score.total > (prev.score ?? -Infinity)) {
          storage.saveBestScore(boardKey, { score: result.score.total, moves: result.moves, ms: result.elapsedMs });
        }
      } catch { /* best-effort */ }
    }

    platform.telemetry('round-end', {
      kind: levelDef.kind, id: levelDef.id, complete, moves: result.moves,
      invalid: result.invalidActions, ms: result.elapsedMs,
    });

    lastResult = {
      result, stars: record.stars || 0, newAchievements: record.newAchievements || [],
      submission, bestBefore, complete, reason,
    };
    roundSettling = false;
    inputLocked = false;
    transition('results', { owner: 'ui', reason: 'round-settled' });
  }

  function onResolving() {
    showScreen('play');
    const note = el('div', { class: 'cp-resolving', role: 'status', text: 'Settling the shelf…' });
    overlayLayer.append(note);
    setTimeout(() => note.remove(), 3000);
  }

  function onResults() {
    audio?.stopAmbience();
    renderResults();
    showScreen('results');
  }

  function renderResults() {
    const s = screens.results;
    s.textContent = '';
    const ctx = lastResult;
    if (!ctx || !ctx.result) return;
    const { result } = ctx;
    const headline = TERMINAL_HEADLINES[ctx.reason] || (ctx.complete ? 'Shelf harmonized!' : 'The shelf resists');

    // Score breakdown table — every labeled component plus the total.
    const rows = (result.score.breakdown || []).map((row) => el('tr', {},
      el('th', { scope: 'row', text: row.label }),
      el('td', { class: row.value < 0 ? 'neg' : '', text: `${row.value < 0 ? '−' : ''}${fmtScore(Math.abs(row.value))}` })));
    const scoreTable = el('table', { class: 'cp-table cp-score-table' },
      el('caption', { class: 'sr-only', text: 'Score breakdown' }),
      el('tbody', {}, rows),
      el('tfoot', {}, el('tr', {},
        el('th', { scope: 'row', text: 'Total' }),
        el('td', { text: fmtScore(result.score.total) }))));

    const statLine = el('p', { class: 'cp-result-stats', text:
      `${result.moves} moves · ${fmtTime(result.elapsedMs)} · ${result.invalidActions} invalid action${result.invalidActions === 1 ? '' : 's'}` });
    const assistsLine = el('p', { class: 'card-dim', text:
      result.assists && (result.assists.hints || result.assists.undos)
        ? `Assists used: ${result.assists.hints} hint${result.assists.hints === 1 ? '' : 's'}, ${result.assists.undos} undo${result.assists.undos === 1 ? '' : 's'}`
        : 'No assists used — a clean pair of hands.' });

    const resultsArt = el('img', {
      class: 'cp-results-art', alt: '', 'aria-hidden': 'true', decoding: 'async',
      src: ctx.complete ? 'assets/results-harmonized.webp' : 'assets/results-resists.webp',
      onerror: () => { resultsArt.hidden = true; },
    });

    const sections = [
      el('h1', { text: headline }),
      resultsArt,
      ctx.complete && levelDef?.kind === 'journey'
        ? el('p', { class: 'cp-stars', 'aria-label': `${ctx.stars} of 3 stars`, text: '★'.repeat(ctx.stars) + '☆'.repeat(3 - ctx.stars) })
        : null,
      scoreTable, statLine, assistsLine,
    ];

    // Achievements
    if (ctx.newAchievements.length) {
      sections.push(el('div', { class: 'panel' },
        el('h2', { text: 'Achievements unlocked' }),
        el('ul', {}, ctx.newAchievements.map((key) => {
          const meta = (storage.ACHIEVEMENTS || []).find((a) => a.key === key);
          return el('li', { text: meta ? `${meta.name} — ${meta.desc}` : key });
        }))));
    }

    // Leaderboard position / comparison
    if (ranked && boardKey) {
      if (ctx.submission && ctx.submission.accepted) {
        sections.push(el('p', { class: 'cp-ranked-note', text: ctx.submission.rank
          ? `Ranked #${ctx.submission.rank} on this board.`
          : 'Score accepted on the ranked board.' }));
      } else {
        sections.push(el('p', { class: 'cp-ranked-note card-dim', text: 'Ranked submission is queued for when the host responds.' }));
      }
    }
    if (ctx.bestBefore != null) {
      const prev = ctx.bestBefore.score ?? ctx.bestBefore;
      const delta = result.score.total - prev;
      if (delta > 0 && ctx.complete) audio?.play('new-best');
      sections.push(el('p', { class: 'card-dim', text: delta > 0
        ? `A new personal best — ${fmtScore(delta)} above your previous ${fmtScore(prev)}.`
        : `Your best remains ${fmtScore(prev)}.` }));
    }

    // Actions: Replay, Next (always exists), Change mode, Progress.
    const next = nextAction();
    sections.push(el('div', { class: 'cp-result-actions' },
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Replay', onclick: () => { audio?.play('ui'); startLevel(levelDef, { ranked, boardKey }); } }),
      el('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': true, text: next.label, onclick: next.run }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Change mode', onclick: () => transition('mode-select', { owner: 'ui', reason: 'results-change-mode' }) }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'View progress', onclick: () => transition('progression', { owner: 'ui', reason: 'results-progress' }) })));

    s.append(...sections.filter(Boolean));
    announce(`${headline} Score ${fmtScore(result.score.total)}.`);
  }

  function nextAction() {
    const prog = storage.loadProgression();
    if (levelDef?.kind === 'journey') {
      const journey = content.JOURNEY || [];
      const idx = journey.findIndex((e) => e.id === levelDef.id);
      const nextEntry = journey[idx + 1];
      if (nextEntry) {
        return { label: `Next: ${nextEntry.name}`, run: () => startLevel(journeyLevel(nextEntry), { ranked: false, boardKey: null }) };
      }
    }
    if (levelDef?.kind === 'challenge') {
      const list = content.CHALLENGES || [];
      const idx = list.findIndex((c) => c.id === levelDef.id);
      const nextC = list[idx + 1];
      if (nextC) {
        return { label: `Next: ${nextC.name}`, run: () => startLevel(challengeLevel(nextC), { ranked: true, boardKey: nextC.id }) };
      }
    }
    if (levelDef?.kind === 'practice') {
      return { label: 'Fresh practice seed', run: () => {
        practiceSeed = freshSeed();
        startLevel(content.practiceLevel(practiceDifficulty, practiceSeed), { ranked: false, boardKey: `practice-${practiceDifficulty}` });
      } };
    }
    const nextStage = nextJourneyStage(prog);
    if (nextStage) {
      return { label: `Journey: ${nextStage.name}`, run: () => startLevel(journeyLevel(nextStage), { ranked: false, boardKey: null }) };
    }
    return { label: 'Practice a fresh shelf', run: () => {
      practiceSeed = freshSeed();
      startLevel(content.practiceLevel(practiceDifficulty, practiceSeed), { ranked: false, boardKey: null });
    } };
  }

  // -------------------------------------------------------------------------
  // Section 15 — HELP screen (rule cards from current bindings + mini boards)
  // -------------------------------------------------------------------------

  function miniVessel(layers, capacity = 4) {
    const tube = el('span', { class: 'vessel-tube mini', 'aria-hidden': 'true' });
    for (let slot = 0; slot < capacity; slot++) {
      const color = layers[slot];
      if (color == null) {
        tube.append(el('span', { class: 'layer slot-empty' }));
      } else {
        const def = colorDef(color);
        tube.append(el('span', {
          class: 'layer', dataset: { color: String(color) },
          style: `--c:${def.hex || `var(--liquid-${color % 10})`}`,
        }, svgUse(SHAPE_IDS[color % SHAPE_IDS.length], 'layer-shape')));
      }
    }
    return el('span', { class: 'vessel static' }, tube);
  }

  function renderHelp() {
    const s = screens.help;
    s.textContent = '';
    const b = settings.bindings;


    const ruleCard = (title, vessels, caption) => el('div', { class: 'panel cp-rule-card' },
      el('h2', { text: title }),
      el('div', { class: 'cp-mini-board' }, vessels),
      el('p', { text: caption }));

    s.append(
      el('h1', { text: 'How to pour' }),
      el('p', { class: 'screen-lede', text: 'The keys below reflect your current control mappings. Change them in Settings.' }),
      el('div', { class: 'cp-rule-grid' },
        ruleCard('A legal pour', [miniVessel([0, 0]), miniVessel([0]), miniVessel([])],
          'Liquid pours onto a matching color, or into an empty vessel. The whole contiguous top run moves together.'),
        ruleCard('Colors must match', [miniVessel([1]), miniVessel([2])],
          'Emberwine will not settle on Tidewater. A mismatched pour is refused with an explanation.'),
        ruleCard('Contiguous runs', [miniVessel([3, 1, 1]), miniVessel([1])],
          'Two touching layers of one color travel as a single pour — deep runs are efficient.'),
        ruleCard('Full vessels refuse', [miniVessel([2, 2, 2, 2]), miniVessel([2])],
          'A full vessel accepts nothing. Finished, harmonized vessels may still pour out.')),
      el('h2', { text: 'Controls' }),
      el('table', { class: 'cp-table' },
        el('tbody', {}, Object.keys(BINDING_LABELS).map((action) => el('tr', {},
          el('th', { scope: 'row', text: BINDING_LABELS[action] }),
          el('td', {}, el('kbd', { text: prettyCodes(b[action] || DEFAULT_BINDINGS[action]) })))))),
      el('p', { class: 'card-dim', text: 'Escape also cancels a selection or pauses. Gamepad: stick or D-pad moves focus, A pours, B cancels, Start pauses, X undoes, Y hints.' }),
      el('div', { class: 'cp-pause-group' },
        el('button', { class: 'btn btn-primary', type: 'button', text: settings.tutorialDone ? 'Replay the lessons' : 'Start the lessons', onclick: () => openSetup('lesson') }),
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-autofocus': true, text: 'Back', onclick: () => backFromSubScreen() })));
  }

  function backFromSubScreen() {
    if (session && (currentState === 'paused')) {
      showScreen('play');
      showPauseOverlay();
      return;
    }
    if (session && (currentState === 'active' || currentState === 'paused')) {
      showScreen('play');
      return;
    }
    buildTitleScreen();
    showScreen('title');
  }

  // -------------------------------------------------------------------------
  // Section 16 — SETTINGS screen
  // -------------------------------------------------------------------------

  let remapCapture = null; // {action, button}

  // Graphics panel: preset, render scale, per-effect overrides, adaptive
  // resolution, frame-rate readout and a live cost summary. Strings follow
  // navigator.language (gfx-strings.js). Every control has a stable id and a
  // data-gfx attribute for tests.
  let gfxSummaryTimer = 0;
  function buildGraphicsSection(section, ...extra) {
    const g = settings.graphics;
    const info = graphicsInfo();
    const detected = info.detected || 'balanced';
    const r = resolveGraphics(g, detected);
    const presetName = (p) => GT.preset[p] || p;
    const tierName = (t) => GT.tier[t] || t;

    const commit = (next, focusId) => {
      settings.graphics = next;
      setSetting('graphics', next);
      const old = document.getElementById('gfx-section');
      if (old) {
        const fresh = buildGraphicsSection(section, ...extra);
        old.replaceWith(fresh);
        const f = focusId && document.getElementById(focusId);
        if (f) f.focus({ preventScroll: true });
      }
    };

    const presetSelect = el('select', { id: 'gfx-preset', 'data-gfx': 'preset', 'aria-label': GT.quality },
      ['auto', ...GFX_PRESETS].map((p) => {
        const opt = el('option', { value: p, text: p === 'auto' ? fmt(GT.auto, { tier: presetName(detected) }) : presetName(p) });
        if ((g.preset || 'auto') === p) opt.selected = true;
        return opt;
      }));
    presetSelect.addEventListener('change', () => commit(choosePreset(settings.graphics, presetSelect.value), 'gfx-preset'));

    const pct = Math.round((Number(g.render_scale) || 1) * 100);
    const scaleValue = el('span', { class: 'cp-slider-value', id: 'gfx-scale-value', text: `${pct}%` });
    const scaleInput = el('input', {
      type: 'range', id: 'gfx-scale', 'data-gfx': 'render_scale', min: '50', max: '200', step: '5',
      value: String(pct), 'aria-label': GT.renderScale,
    });
    scaleInput.addEventListener('input', () => { scaleValue.textContent = `${scaleInput.value}%`; });
    scaleInput.addEventListener('change', () => commit({ ...settings.graphics, render_scale: Number(scaleInput.value) / 100 }, 'gfx-scale'));

    const catFields = Object.entries(GFX_CATEGORIES).map(([cat, tiers]) => {
      const sel = el('select', { id: `gfx-${cat}`, 'data-gfx': cat, 'aria-label': GT.cat[cat] },
        ['preset', ...tiers].map((t) => {
          const opt = el('option', {
            value: t,
            text: t === 'preset' ? fmt(GT.fromPreset, { tier: tierName(presetTier(r.preset, cat)) }) : tierName(t),
          });
          if ((tiers.includes(g[cat]) ? g[cat] : 'preset') === t) opt.selected = true;
          return opt;
        }));
      sel.addEventListener('change', () => {
        const next = { ...settings.graphics };
        if (sel.value === 'preset') delete next[cat]; else next[cat] = sel.value;
        commit(next, `gfx-${cat}`);
      });
      return el('label', { class: 'cp-field' }, el('span', { text: GT.cat[cat] }), sel);
    });

    const check = (id, key, label, value) => {
      const input = el('input', { type: 'checkbox', id, 'data-gfx': key, 'aria-label': label });
      input.checked = value;
      input.addEventListener('change', () => commit({ ...settings.graphics, [key]: input.checked }, id));
      return el('label', { class: 'cp-field cp-toggle' }, el('span', { text: label }), input);
    };

    const summary = el('p', { class: 'cp-gfx-summary card-dim', id: 'gfx-summary', 'aria-live': 'polite' });
    const note = el('p', { class: 'cp-gfx-note', id: 'gfx-note', hidden: true });
    const refresh = () => {
      const now = graphicsInfo();
      let text;
      if (now.summary) {
        text = now.summary;
      } else {
        const pr = gfxPixelRatio(r, window.devicePixelRatio || 1);
        text = describeGraphics(r, [Math.round(window.innerWidth * pr), Math.round(window.innerHeight * pr)]);
      }
      const fps = r.showFps && now.fps ? ` · ${now.fps} fps` : '';
      summary.textContent = `${now.gpu || GT.unknownGpu} · ${text}${fps}`;
      if (!isWebGL) { note.textContent = GT.noWebgl; note.hidden = false; }
      else if (now.postFailed) { note.textContent = GT.postFailed; note.hidden = false; }
      else note.hidden = true;
    };
    refresh();
    clearInterval(gfxSummaryTimer);
    gfxSummaryTimer = setInterval(() => {
      if (!summary.isConnected) { clearInterval(gfxSummaryTimer); return; }
      if (!screens.settings.hidden) refresh();
    }, 1000);

    const sec = section('Graphics',
      el('label', { class: 'cp-field' }, el('span', { text: GT.quality }), presetSelect),
      el('label', { class: 'cp-field' }, el('span', { text: GT.renderScale }), scaleInput, scaleValue),
      el('div', { class: 'cp-gfx-grid' }, catFields),
      check('gfx-adaptive', 'adaptive', GT.adaptive, g.adaptive !== false),
      check('gfx-fps', 'show_fps', GT.showFps, !!g.show_fps),
      summary, note,
      ...extra);
    sec.id = 'gfx-section';
    sec.dataset.gfxPreset = r.preset;
    return sec;
  }

  function renderSettings() {
    const s = screens.settings;
    s.textContent = '';
    s.append(el('h1', { text: 'Settings' }));

    const section = (title, ...children) => el('section', { class: 'panel cp-settings-section' },
      el('h2', { text: title }), ...children);

    const slider = (label, key, bus) => {
      const value = el('span', { class: 'cp-slider-value', text: `${Math.round((settings[key] ?? 0) * 100)}%` });
      const input = el('input', {
        type: 'range', min: '0', max: '1', step: '0.05', value: String(settings[key] ?? 0),
        'aria-label': label,
      });
      input.addEventListener('input', () => {
        settings[key] = Number(input.value);
        value.textContent = `${Math.round(settings[key] * 100)}%`;
        if (audio) audio.setVolume(bus, settings[key]);
      });
      input.addEventListener('change', () => persistSettings(key));
      return el('label', { class: 'cp-field' }, el('span', { text: label }), input, value);
    };

    const toggle = (label, key, onChange, opts = {}) => {
      const input = el('input', { type: 'checkbox', 'aria-label': label });
      input.checked = !!settings[key];
      if (opts.disabled) input.disabled = true;
      input.addEventListener('change', () => {
        setSetting(key, input.checked);
        if (onChange) onChange(input.checked);
      });
      return el('label', { class: `cp-field cp-toggle${opts.disabled ? ' disabled' : ''}` },
        el('span', { text: label }), input,
        opts.note ? el('span', { class: 'card-dim', text: opts.note }) : null);
    };

    // -- Audio --
    s.append(section('Audio',
      slider('Music', 'music', 'music'),
      slider('Effects', 'effects', 'effects'),
      slider('Ambience', 'ambience', 'ambience'),
      slider('Voice', 'voice', 'voice')));

    // -- Graphics --
    const themeSelect = el('select', { 'aria-label': 'Shelf theme' },
      (content.THEMES || []).map((t) => {
        const opt = el('option', { value: t.id, text: t.name || t.id });
        if (settings.theme === t.id) opt.selected = true;
        return opt;
      }));
    themeSelect.addEventListener('change', () => setSetting('theme', themeSelect.value));
    s.append(buildGraphicsSection(section,
      el('label', { class: 'cp-field' }, el('span', { text: 'Shelf theme' }), themeSelect),
      toggle('Reduced motion', 'reducedMotion'),
      toggle('Wide camera', 'cameraWide')));

    // -- Controls --
    const bindingsList = el('div', { class: 'cp-bindings' },
      Object.keys(BINDING_LABELS).map((action) => {
        const btn = el('button', {
          class: 'btn btn-ghost cp-binding-key', type: 'button',
          text: prettyCodes(settings.bindings[action]),
          'aria-label': `${BINDING_LABELS[action]}, currently ${prettyCodes(settings.bindings[action])}. Activate to remap.`,
          onclick: () => beginRemap(action, btn),
        });
        return el('div', { class: 'cp-binding-row' },
          el('span', { text: BINDING_LABELS[action] }), btn);
      }));
    s.append(section('Controls',
      bindingsList,
      el('p', { class: 'card-dim', text: 'Choose a control, then press the new key. Signed in to StarHermit, your keys follow you to other devices.' }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: 'Reset keys to defaults', onclick: () => resetBindings() }),
      toggle('Left-handed tray', 'leftHanded'),
      toggle('Hold to confirm selection', 'holdToConfirm')));

    // -- Accessibility --
    const paletteRow = el('div', { class: 'cp-palette-picker', role: 'radiogroup', 'aria-label': 'Color palette' },
      Object.keys(content.COLOR_SETS || {}).map((key) => {
        const set = content.COLOR_SETS[key];
        const swatches = el('span', { class: 'cp-swatches', 'aria-hidden': 'true' },
          set.slice(0, 5).map((c) => el('span', { class: 'cp-swatch', style: `background:${c.hex}` })));
        const btn = el('button', {
          class: `cp-palette-option${settings.palette === key ? ' chosen' : ''}`, type: 'button',
          role: 'radio', 'aria-checked': settings.palette === key ? 'true' : 'false',
          onclick: () => {
            setSetting('palette', key);
            if (session) renderBoard();
            renderSettings();
            showScreen('settings');
          },
        }, swatches, el('span', { text: key[0].toUpperCase() + key.slice(1) }));
        return btn;
      }));
    s.append(section('Accessibility',
      el('div', { class: 'cp-field' }, el('span', { text: 'Color palette' }), paletteRow),
      toggle('Labels on liquids', 'labelsOnLiquids', () => { if (session) renderBoard(); }),
      toggle('Larger text', 'largerText'),
      toggle('High contrast', 'highContrast'),
      toggle('Reduced motion', 'reducedMotion'),
      toggle('Haptics', 'hapticsOff', null, { disabled: true, note: 'This device does not expose haptics to the browser yet.' })));

    // -- Gameplay --
    s.append(section('Gameplay',
      toggle('Hints enabled', 'hintsEnabled', () => syncActionStates())));

    // -- Data --
    const exportBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Export save', onclick: exportSave });
    const importInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only' });
    importInput.addEventListener('change', () => importSave(importInput.files?.[0], importInput));
    const importBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: 'Import save', onclick: () => importInput.click() });
    const resetBtn = el('button', { class: 'btn btn-danger', type: 'button', text: 'Reset all progress', onclick: resetProgress });
    const consentToggle = toggle('Share anonymous usage events', 'telemetryConsent');
    s.append(section('Data',
      consentToggle,
      el('p', { class: 'card-dim', text: 'With consent on, the game sends only anonymous funnel events — starts, round ends, settings changes, error categories. Never text, never pointers, never identifiers.' }),
      el('div', { class: 'cp-pause-group' }, exportBtn, importBtn, importInput, resetBtn)));

    s.append(el('button', { class: 'btn btn-ghost', type: 'button', 'data-autofocus': true, text: 'Back', onclick: () => backFromSubScreen() }));
  }

  function resetBindings() {
    settings.bindings = normalizeBindings(null);
    codeMap = null;
    persistSettings('bindings');
    platform.resetControls().catch(() => {});
    renderSettings();
    announce('Keys reset to defaults.');
  }

  function beginRemap(action, btn) {
    if (remapCapture) remapCapture.button.classList.remove('capturing');
    remapCapture = { action, button: btn };
    btn.classList.add('capturing');
    btn.textContent = 'Press a key…';
    announce(`Remapping ${BINDING_LABELS[action]}. Press the new key, or Escape to cancel.`);
  }

  function exportSave() {
    try {
      const doc = storage.checksumDoc({
        exportedAt: new Date().toISOString(),
        settings,
        progression: storage.loadProgression(),
      });
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'chromatic-pour-save.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      notify('Save exported — keep the file somewhere safe.');
    } catch {
      showError('storage');
    }
  }

  async function importSave(file, inputEl) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = storage.verifyDoc(JSON.parse(text));
      if (!data) {
        announce('That save file failed its checksum — nothing was imported.', true);
        return;
      }
      const ok = await confirmDialog(
        'Import save?',
        'This replaces the settings and progress stored on this device. Your current local save will be overwritten.',
        'Import and replace');
      if (!ok) return;
      if (data.settings) {
        Object.assign(settings, data.settings);
        settings.bindings = normalizeBindings(settings.bindings);
        codeMap = null;
        saveSettings(settings);
      }
      if (data.progression) storage.saveProgression(data.progression);
      applyVisualSettings();
      applyAudioSettings();
      updateRenderer({ settings });
      buildTitleScreen();
      renderSettings();
      showScreen('settings');
      notify('Save imported. The shelf remembers.');
    } catch {
      announce('That file could not be read as a Chromatic Pour save.', true);
    } finally {
      if (inputEl) inputEl.value = '';
    }
  }

  async function resetProgress() {
    const first = await confirmDialog('Reset all progress?', 'Stars, streaks, achievements and bests on this device will be erased.', 'Erase progress');
    if (!first) return;
    const second = await confirmDialog('Are you certain?', 'This cannot be undone. Exported saves can restore it later.', 'Yes, erase everything');
    if (!second) return;
    storage.saveProgression({
      version: 1, journey: {}, dailies: {}, achievements: {},
      mastery: { completed: [] }, sessionsPlayed: 0, lastStreakDay: null, streak: 0,
    });
    // The dialog promised "bests on this device will be erased" — keep it true.
    try { storage.clearLocalProgress(); } catch { /* best-effort */ }
    settings.tutorialDone = false;
    saveSettings(settings);
    buildTitleScreen();
    notify('Progress erased. A blank ledger, a clean shelf.');
  }

  // -------------------------------------------------------------------------
  // Section 17 — PROGRESSION screen
  // -------------------------------------------------------------------------

  function renderProgression() {
    const s = screens.progression;
    s.textContent = '';
    const prog = storage.loadProgression();
    const journey = content.JOURNEY || [];
    const stars = totalJourneyStars(prog);
    const beaten = Object.keys(prog.journey || {}).length;
    const masteryStages = journey.filter((e) => e.mastery);
    const masteryDone = masteryStages.filter((e) => (prog.journey || {})[e.id]);
    const masteryList = (prog.mastery && prog.mastery.completed) || [];

    const bestDailyEntry = Object.entries(prog.dailies || {})
      .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))[0];

    s.append(
      el('h1', { text: 'The ledger of the shelf' }),
      el('div', { class: 'cp-progress-grid' },
        el('div', { class: 'panel' },
          el('h2', { text: 'Journey' }),
          el('p', { class: 'cp-big-stat', text: `${stars} / ${journey.length * 3} ★` }),
          el('p', { text: `${beaten} of ${journey.length} stages harmonized.` }),
          el('p', { class: 'card-dim', text: nextJourneyStage(prog)
            ? `Next stage: ${nextJourneyStage(prog).name}`
            : 'Every stage complete. The shelf is yours.' })),
        el('div', { class: 'panel' },
          el('h2', { text: 'Mastery track' }),
          el('p', { class: 'cp-big-stat', text: `${masteryDone.length} / ${masteryStages.length} ◆` }),
          el('p', { class: 'card-dim', text: masteryStages.length
            ? `Mastery stages test combined mechanics. ${masteryList.length ? `${masteryList.length} recorded on the mastery roll.` : 'None recorded yet.'}`
            : 'Mastery stages appear as the journey grows.' })),
        el('div', { class: 'panel' },
          el('h2', { text: 'Achievements' }),
          el('ul', { class: 'cp-achievements' },
            (storage.ACHIEVEMENTS || []).map((a) => {
              const unlocked = (prog.achievements || {})[a.key];
              return el('li', { class: unlocked ? 'unlocked' : 'locked' },
                el('strong', { text: a.name }),
                el('span', { class: 'card-dim', text: unlocked ? ` — ${a.desc} (unlocked)` : ` — ${a.desc}` }));
            }))),
        el('div', { class: 'panel' },
          el('h2', { text: 'Figures' }),
          el('p', { text: `${prog.sessionsPlayed || 0} rounds played` }),
          el('p', { text: `Daily streak: ${prog.streak || 0} day${(prog.streak || 0) === 1 ? '' : 's'}` }),
          el('p', { text: bestDailyEntry ? `Best daily: ${fmtScore(bestDailyEntry[1].score || 0)} (${bestDailyEntry[0]})` : 'No daily draught poured yet.' }))),
      el('div', { class: 'cp-pause-group' },
        el('button', {
          class: 'btn btn-primary', type: 'button', 'data-autofocus': true,
          text: nextJourneyStage(prog) ? 'Continue the Journey' : 'Practice a shelf',
          onclick: () => {
            const next = nextJourneyStage(prog);
            if (next) startLevel(journeyLevel(next), { ranked: false, boardKey: null });
            else openSetup('practice');
          },
        }),
        el('button', { class: 'btn btn-ghost', type: 'button', text: 'Back to title', onclick: () => { buildTitleScreen(); transition('title', { owner: 'ui', reason: 'progression-back' }); } })));
  }

  // -------------------------------------------------------------------------
  // Section 18 — TUTORIAL flow
  // -------------------------------------------------------------------------

  let tutorialCard = null;

  function currentStep() {
    if (!tutorial) return null;
    return tutorial.lesson.steps[tutorial.stepIndex] || null;
  }

  function onTutorial() {
    showScreen('play');
    // Each step owns its own board. The session for it was created by
    // startLevel (step 0) or by advanceTutorial (later steps).
    if (session && !session.state) {
      const state = session.start();
      renderBoard(state);
      const r = getRenderer();
      if (r) { try { r.setState(state); } catch { /* decorative */ } }
    }
    updateHud();
    showTutorialCard();
    focusVesselButton(firstPlayableVessel());
  }

  function showTutorialCard() {
    hideTutorialCard();
    const step = currentStep();
    if (!step) return;
    tutorialCard = el('div', { class: 'cp-tutorial-card panel', role: 'dialog', 'aria-label': 'Lesson step' },
      el('p', { class: 'card-kicker', text: `${tutorial.lesson.title || 'Lesson'} — step ${tutorial.stepIndex + 1} of ${tutorial.lesson.steps.length}` }),
      el('p', { class: 'cp-tutorial-text', text: step.text || '' }));
    overlayLayer.append(tutorialCard);
    announce(step.text || '');
  }

  function hideTutorialCard() {
    tutorialCard?.remove();
    tutorialCard = null;
  }

  function hideTutorialCardIfNotTutorial() {
    if (!tutorial) hideTutorialCard();
  }

  // Gate every vessel intent through the lesson's requirement.
  function tutorialVesselIntent(i) {
    const step = currentStep();
    if (!step) { handleSelectResult(session.selectVessel(i)); return; }
    const req = step.require || {};
    const selected = session.selected;

    if (req.kind === 'select') {
      if (req.from == null || i === req.from) {
        const res = session.selectVessel(i);
        handleSelectResult(res);
        if (res.kind === 'selected') advanceTutorial();
      } else {
        denyTutorial(i, step, 'That is not the vessel the lesson asks for.');
      }
      return;
    }
    if (req.kind === 'pour' || req.kind === 'pour-color') {
      if (selected == null) {
        if (req.from == null || i === req.from) {
          handleSelectResult(session.selectVessel(i));
        } else {
          denyTutorial(i, step, 'Start with the vessel the lesson names.');
        }
        return;
      }
      if (i === selected) { handleSelectResult(session.selectVessel(i)); return; }
      if (req.to != null && i !== req.to) {
        denyTutorial(i, step, 'Pour into the vessel the lesson names.');
        return;
      }
      if (req.kind === 'pour-color' && req.color != null) {
        const run = rules.topRun(session.state, selected);
        if (!run || run.color !== req.color) {
          denyTutorial(i, step, 'The lesson asks for a specific color.');
          return;
        }
      }
      const res = session.selectVessel(i);
      handleSelectResult(res);
      if (res.kind === 'pour') advanceTutorial();
      return;
    }
    if (req.kind === 'undo' || req.kind === 'restart') {
      denyTutorial(i, step, `Use the ${req.kind === 'undo' ? 'Undo' : 'Restart'} button for this step.`);
      return;
    }
    handleSelectResult(session.selectVessel(i));
  }

  // Gate for non-vessel actions (undo/restart). Returns true when the action
  // is allowed; the caller performs the action, then calls advanceTutorial().
  function tutorialGate(kind) {
    const step = currentStep();
    if (!step) return true;
    const req = step.require || {};
    if (req.kind === kind) return true;
    announce('The lesson asks for something else first — follow the instruction card.', true);
    audio?.play('invalid');
    return false;
  }

  function denyTutorial(i, step, prefix) {
    audio?.play('invalid');
    showInvalidOnVessel(i, prefix);
    if (step.hintText) {
      announce(`${prefix} ${step.hintText}`, true);
      toast(step.hintText, 'hint');
    }
  }

  function advanceTutorial() {
    audio?.play('layer-complete');
    tutorial.stepIndex += 1;
    const step = currentStep();
    if (step && step.continues && session) {
      // The next instruction builds on the current board and selection.
      showTutorialCard();
      platform.telemetry('tutorial-step', { lesson: tutorial.lesson.id, step: tutorial.stepIndex });
      return;
    }
    if (step) {
      // Next step gets its own seeded board.
      levelDef = lessonLevel(tutorial.lesson, step, tutorial.stepIndex);
      session = new GameSession(levelDef, { now: () => Date.now() });
      const state = session.start();
      inputLocked = false;
      renderBoard(state);
      updateHud();
      const r = getRenderer();
      if (r) { try { r.setState(state); r.setSelected(null); } catch { /* decorative */ } }
      showTutorialCard();
      platform.telemetry('tutorial-step', { lesson: tutorial.lesson.id, step: tutorial.stepIndex });
      return;
    }
    // Lesson complete.
    hideTutorialCard();
    settings.tutorialDone = true;
    saveSettings(settings);
    toast('Lesson complete — the shelf approves.', 'achievement');
    announce('Lesson complete.');
    tutorial = null;
    session = null;
    buildTitleScreen();
    transition('title', { owner: 'ui', reason: 'lesson-complete' });
  }

  // -------------------------------------------------------------------------
  // Section 19 — keyboard + gamepad input
  // -------------------------------------------------------------------------

  function moveVesselFocus(delta) {
    const buttons = vesselButtons().filter((b) => !b.disabled);
    if (!buttons.length) return;
    const active = document.activeElement;
    const idx = buttons.indexOf(active);
    const next = buttons[(idx + delta + buttons.length) % buttons.length] || buttons[0];
    next.focus();
  }

  function moveVesselFocusVertical(direction) {
    const buttons = vesselButtons().filter((b) => !b.disabled);
    if (buttons.length < 2) return;
    const active = document.activeElement;
    const idx = buttons.indexOf(active);
    if (idx === -1) { buttons[0].focus(); return; }
    // Row width: count buttons sharing the first row's vertical offset.
    const firstTop = buttons[0].offsetTop;
    let rowSize = buttons.findIndex((b) => b.offsetTop !== firstTop);
    if (rowSize <= 0) rowSize = buttons.length;
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, idx + direction * rowSize))];
    next.focus();
  }

  function cancelOrPause() {
    if (currentState === 'paused') { resumeRound(); return; }
    if (currentState !== 'active' && currentState !== 'tutorial') return;
    if (session && session.selected != null) {
      session.clearSelection();
      audio?.play('deselect');
      announce('Selection cleared.');
      renderBoard();
      const r = getRenderer();
      if (r) { try { r.setSelected(null); r.previewTargets(null); } catch { /* decorative */ } }
      return;
    }
    pauseRound();
  }

  function recenterView() {
    playRefs.playfield?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    const r = getRenderer();
    if (r) { try { r.focusVessel(null); } catch { /* decorative */ } }
    announce('View recentered on the shelf.');
  }

  document.addEventListener('keydown', (e) => {
    // Overlay handlers (pause, dialogs) run in capture phase and claim keys.
    if (e.defaultPrevented) return;
    // Remap capture mode swallows everything.
    if (remapCapture) {
      e.preventDefault();
      e.stopPropagation();
      const { action, button } = remapCapture;
      remapCapture = null;
      button.classList.remove('capturing');
      if (e.code !== 'Escape' && e.code) {
        // A code belongs to exactly one action: take it from any other.
        for (const a of Object.keys(settings.bindings)) {
          if (a !== action) {
            const rest = settings.bindings[a].filter((c) => c !== e.code);
            settings.bindings[a] = rest.length ? rest : DEFAULT_BINDINGS[a].filter((c) => c !== e.code);
          }
        }
        settings.bindings[action] = [e.code];
        codeMap = null;
        persistSettings('bindings');
        platform.setControls(settings.bindings);
        announce(`${BINDING_LABELS[action]} is now ${prettyCodes([e.code])}.`);
      } else {
        announce('Remap cancelled.');
      }
      button.textContent = prettyCodes(settings.bindings[action]);
      return;
    }

    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    const act = actionFor(e);

    if (inField) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    const playing = currentState === 'active' || currentState === 'tutorial';
    if (!playing) return;

    if (e.key === 'Escape' || act === 'cancel') { e.preventDefault(); cancelOrPause(); return; }
    if (act === 'pause') { e.preventDefault(); pauseRound(); return; }
    if (act === 'focusNext') { e.preventDefault(); moveVesselFocus(1); return; }
    if (act === 'focusPrev') { e.preventDefault(); moveVesselFocus(-1); return; }
    if (act === 'focusUp') { e.preventDefault(); moveVesselFocusVertical(-1); return; }
    if (act === 'focusDown') { e.preventDefault(); moveVesselFocusVertical(1); return; }
    if (act === 'confirm') {
      // Enter/Space activate the focused vessel natively; a rebound key pours too.
      if (e.code === 'Enter' || e.code === 'Space') return;
      const active = document.activeElement;
      if (active?.classList?.contains('vessel')) { e.preventDefault(); onVesselActivate(Number(active.dataset.index)); }
      return;
    }
    if (act === 'undo') { e.preventDefault(); doUndo(); return; }
    if (act === 'hint') { e.preventDefault(); doHint(); return; }
    if (act === 'restart') { e.preventDefault(); doRestart(); return; }
    if (act === 'cameraReset') { e.preventDefault(); recenterView(); }
  });

  // Hold-to-confirm pointer handling on the board.
  document.addEventListener('pointerdown', (e) => {
    if (!settings.holdToConfirm) return;
    const btn = e.target.closest?.('.vessel');
    if (!btn) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      onVesselActivate(Number(btn.dataset.index));
    }, 320);
  });
  for (const evt of ['pointerup', 'pointercancel']) {
    document.addEventListener(evt, () => clearTimeout(holdTimer));
  }

  function pollGamepad(now) {
    if (currentState !== 'active' && currentState !== 'tutorial') return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return;
    const gp = settings.gamepadRemap || {};
    const idx = { confirm: 0, cancel: 1, undo: 2, hint: 3, pause: 9, ...gp };
    const pressedNow = pad.buttons.map((btn) => !!btn?.pressed);
    const justPressed = (i) => pressedNow[i] && !gamepadPrev[i];

    if (justPressed(idx.confirm)) {
      const active = document.activeElement;
      if (active?.classList?.contains('vessel')) onVesselActivate(Number(active.dataset.index));
      else focusVesselButton(firstPlayableVessel());
    }
    if (justPressed(idx.cancel)) cancelOrPause();
    if (justPressed(idx.pause)) (currentState === 'paused' ? resumeRound() : pauseRound());
    if (justPressed(idx.undo)) doUndo();
    if (justPressed(idx.hint)) doHint();

    // D-pad (12–15) + left stick with 300 ms auto-repeat.
    const axis = pad.axes[0] || 0;
    const axisY = pad.axes[1] || 0;
    let dir = 0;
    if (pressedNow[14] || axis < -0.5) dir = -1;
    else if (pressedNow[15] || axis > 0.5) dir = 1;
    let vdir = 0;
    if (pressedNow[12] || axisY < -0.5) vdir = -1;
    else if (pressedNow[13] || axisY > 0.5) vdir = 1;
    const fresh = (dir !== 0 && !gamepadPrev._dir) || (vdir !== 0 && !gamepadPrev._vdir);
    if ((dir || vdir) && (fresh || now >= gamepadRepeatAt)) {
      if (dir) moveVesselFocus(dir);
      else if (vdir) moveVesselFocusVertical(vdir);
      gamepadRepeatAt = now + 300;
    }
    pressedNow._dir = dir;
    pressedNow._vdir = vdir;
    gamepadPrev = pressedNow;
  }

  // -------------------------------------------------------------------------
  // Section 20 — state presentation, tick, while-away
  // -------------------------------------------------------------------------

  function presentState(name) {
    currentState = name;
    switch (name) {
      case 'title':
      case 'profile-ready':
        audio?.stopAmbience();
        tutorial = null;
        buildTitleScreen();
        updateProfileChip();
        showScreen('title');
        if (name === 'profile-ready' && platform.profile?.displayName) {
          announce(`Welcome back, ${platform.profile.displayName}.`);
        }
        break;
      case 'mode-select':
        buildModeSelect();
        showScreen('modes');
        break;
      case 'preparing': onPreparing(); break;
      case 'tutorial': onTutorial(); break;
      case 'countdown': onCountdown(); break;
      case 'active': onActive(); break;
      case 'paused': onPaused(); break;
      case 'resolving': onResolving(); break;
      case 'results': onResults(); break;
      case 'progression':
        renderProgression();
        showScreen('progression');
        break;
      default:
        break;
    }
  }

  let fpsAccum = 0;
  function tick(dtMs) {
    fpsAccum += dtMs;
    if (currentState === 'active' || currentState === 'tutorial') {
      updateTimer();
      pollGamepad(performance.now());
    }
    // A time limit binds even when the player stops pouring — fail the round
    // the moment the clock runs out (a pour in flight enforces it in rules).
    if (currentState === 'active' && !inputLocked && session && session.checkTimeout()) {
      renderBoard();
      updateHud();
      endRound({ type: 'failed', reason: rules.TERMINAL.TIME_LIMIT });
    }
    if (!screens.title.hidden) tickDailyCountdown();
  }

  function announceWhileAway(ms) {
    if (ms < 5000) return;
    const message = `Welcome back to the shelf — away for ${fmtAway(ms)}. The round clock was paused.`;
    toast(message, 'info');
    announce(message);
    if (session && currentState === 'active') updateTimer();
  }

  // -------------------------------------------------------------------------
  // Section 21 — first paint + returned API
  // -------------------------------------------------------------------------

  applyVisualSettings();
  applyAudioSettings();
  updateProfileChip();
  buildTitleScreen();
  if (!isWebGL) {
    // Slim classic-view notice; the game is fully playable without WebGL.
    setTimeout(() => notify(ERROR_MESSAGES.webgl), 800);
  }

  return {
    tick,
    showError,
    presentState,
    announceWhileAway,
    notify,
    getState: () => currentState,
    getSession: () => session,
  };
}
