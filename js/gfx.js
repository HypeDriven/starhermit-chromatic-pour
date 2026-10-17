// gfx.js — graphics quality model for Chromatic Pour.
// Presets, per-category overrides, GPU detection and a cost summary. Pure (no
// three.js, no DOM) so the Settings panel, the renderer and the unit tests
// agree on what every setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],     // candle/key-light shadows on shelf and wall
  ao: ['off', 'on', 'high'],                     // GTAO contact darkening
  bloom: ['off', 'on'],                          // glow on flame, orbs and bright liquid
  grade: ['off', 'on'],                          // colour grade + vignette
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],                    // image-based lighting (room environment)
  particles: ['low', 'high'],                    // drifting motes + celebration budget
  background: ['static', 'animated'],            // candle flicker, orb bob, drifting motes
  detail: ['plain', 'detailed'],                 // plaster/wood relief + glass detail on the board
};

// Each preset is a row of tiers plus a render scale (multiplies the pixel ratio)
// and a device-pixel-ratio cap so Low costs no more than the original renderer.
const TABLE = {
  low: { scale: 1, maxDpr: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low', background: 'animated', detail: 'plain' },
  balanced: { scale: 0.9, maxDpr: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, maxDpr: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, maxDpr: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };
export const PARTICLE_BUDGET = { low: 80, high: 500 };
export const MOTE_COUNT = { low: 0, high: 60 };

export const DEFAULT_GRAPHICS = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → globalThis.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  const sys = typeof system === 'boolean' ? { mobile: system } : (system || {});
  return G.detectLevel({ ...sys, gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for a GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

// The detected hardware level of this device (set once at boot by main.js); budgets scale with it.
let hardwareLevel = PRESET_LEVELS.balanced;
export function setHardwareLevel(level) { hardwareLevel = Math.max(0, Math.min(20, Number(level) || 0)); }
export function getHardwareLevel() { return hardwareLevel; }

/** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor). */
function scaleCount(n, preset, level) {
  const G = gpuApi();
  const floor = PRESET_LEVELS[preset] || 0;
  return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
}

/*
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
 *   material      environment materials: 'lambert' | 'standard' | 'physical' (sheen candle wax);
 *   woodTexture / stoneTexture  shelf-wood and stone-wall canvas widths in px (the stone is half as tall);
 *   segments      round-prop LOD: multiplies the radial/height segments of candle, dish, scrolls, pot,
 *                 flasks, corks and orbs (min 6);
 *   flaskGlass    'clear' (alpha glass) | 'transmission' (refracting glass; costs a transmission pass);
 *   motes / particles  dust motes and pooled celebration particles at the floor level (scaled up with the
 *                 level; the Particles tier caps them: low → no motes, 80 particles);
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame;
 *   maxRatio      ceiling on the canvas pixel ratio after the UI zoom (ui-scale.js) multiplies it;
 *   uiBlur        backdrop blur behind the HUD panels (a full-surface GPU pass each; off → opaque panels).
 */
export const BUDGETS = {
  low: { material: 'lambert', woodTexture: 128, stoneTexture: 256, segments: 0.5, flaskGlass: 'clear', motes: 0, particles: 60, bloomRes: 0.5, aoRes: 0.5, maxRatio: 1, uiBlur: false },
  balanced: { material: 'standard', woodTexture: 256, stoneTexture: 256, segments: 0.75, flaskGlass: 'clear', motes: 24, particles: 160, bloomRes: 0.5, aoRes: 0.5, maxRatio: 1.5, uiBlur: false },
  high: { material: 'physical', woodTexture: 512, stoneTexture: 512, segments: 1, flaskGlass: 'transmission', motes: 40, particles: 300, bloomRes: 0.5, aoRes: 0.5, maxRatio: 2, uiBlur: true },
  ultra: { material: 'physical', woodTexture: 512, stoneTexture: 1024, segments: 1.5, flaskGlass: 'transmission', motes: 60, particles: 500, bloomRes: 1, aoRes: 1, maxRatio: 2.5, uiBlur: true },
};
export const MOTE_CAP = { low: 0, high: 160 };
export const PARTICLE_CAP = { low: 80, high: 1000 };

/** A preset's concrete budget for a hardware level and Particles tier. */
export function budgetFor(preset, level, particles = 'high') {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  b.motes = Math.min(MOTE_CAP[particles] ?? MOTE_CAP.high, scaleCount(b.motes, preset, level));
  b.particles = Math.min(PARTICLE_CAP[particles] ?? PARTICLE_CAP.high, scaleCount(b.particles, preset, level));
  return b;
}

/**
 * Resolve saved graphics settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level = hardwareLevel) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset,
    auto,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
    maxDpr: row.maxDpr,
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = level;
  out.budget = budgetFor(preset, level, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
    out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Choosing a preset clears every per-category override. */
export function choosePreset(saved, preset) {
  const s = { ...DEFAULT_GRAPHICS, ...(saved && typeof saved === 'object' ? saved : {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** Map the pre-presets `quality` setting ('auto'|'high'|'medium'|'low') onto a graphics object. */
export function migrateQuality(quality) {
  const map = { high: 'high', medium: 'balanced', low: 'low' };
  return { ...DEFAULT_GRAPHICS, preset: map[quality] || 'auto' };
}

/** Pixel ratio the renderer should use. */
export function pixelRatio(r, dpr, adaptiveScale = 1) {
  return Math.min(dpr || 1, r.maxDpr) * r.scale * adaptiveScale;
}

/** Short cost summary, e.g. "1024² shadows · bloom · SMAA · 1280×720 px". */
// Cost-summary words go through the game language (js/i18n.js) when loaded.
const T = (k, v) => (globalThis.CPI18N ? globalThis.CPI18N.T(k, v) : String(k).replace(/\{(\w+)\}/g, (m, x) => (v && x in v ? v[x] : m)));

export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? T('no shadows') : T('{size}² shadows', { size: SHADOW_MAP[r.shadows] }),
    r.ao === 'off' ? null : r.ao === 'high' ? T('full AO') : 'AO',
    r.bloom === 'on' ? T('bloom') : null,
    r.reflections === 'on' ? T('reflections') : null,
    r.antialias === 'off' ? T('no AA') : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
