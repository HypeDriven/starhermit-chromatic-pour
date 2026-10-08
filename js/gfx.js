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
  balanced: { scale: 1, maxDpr: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, maxDpr: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, maxDpr: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };
export const PARTICLE_BUDGET = { low: 80, high: 500 };
export const MOTE_COUNT = { low: 0, high: 60 };

export const DEFAULT_GRAPHICS = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };

/**
 * Best preset for this GPU, from the unmasked renderer string when the browser
 * exposes it. Touch/mobile devices are capped at Balanced.
 */
export function detectPreset(gpu, mobile = false) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
  if (mobile && p === 'high') p = 'balanced';
  return p;
}

/**
 * Resolve saved graphics settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
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
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full AO' : 'AO',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
