// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the dust motes and celebration particles scaled within the tier by the
// level (frame().levelIndex), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout, and the
// shadow-map size and MSAA samples it holds to the level. The old panel's
// per-category overrides are not offered (the runtime's Options choose a
// level). The refracting "transmission" flask glass of High and Ultra is
// clear glass on the engine (it draws no transmission).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Environment materials: Lambert, standard PBR, or physical (clearcoat brass and wax). */
  material: "lambert" | "standard" | "physical";
  /** Shelf-wood and stone-wall canvas widths in px. */
  woodTexture: number;
  stoneTexture: number;
  /** Round-prop LOD: multiplies the radial segments (min 6). */
  segments: number;
  /** Dust motes in the candle light and pooled celebration particles. */
  motes: number;
  particles: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Room-environment reflections on glass and brass. */
  reflections: boolean;
  /** Stone wall with relief, brass trim and corbels, the specimen flasks, the glass detail on the board. */
  detailed: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", woodTexture: 128, stoneTexture: 256, segments: 0.5, motes: 0, particles: 60 },
  balanced: { material: "standard", woodTexture: 256, stoneTexture: 256, segments: 0.75, motes: 24, particles: 160 },
  high: { material: "physical", woodTexture: 512, stoneTexture: 512, segments: 1, motes: 40, particles: 300 },
  ultra: { material: "physical", woodTexture: 512, stoneTexture: 1024, segments: 1.5, motes: 60, particles: 500 },
};
export const MOTE_CAP = 160;
export const PARTICLE_CAP = 1000;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most four times the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.motes = Math.min(MOTE_CAP, Math.round(b.motes * k));
  b.particles = Math.min(PARTICLE_CAP, Math.round(b.particles * k));
  return { preset, ...TABLE[preset], budget: b };
}
