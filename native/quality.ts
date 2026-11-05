// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom and their resolutions, the grade,
// anti-aliasing) are the level's own (levelSettings(): the same table every
// StarHermit game reads). The game's art (materials, wood and stone
// textures, round-prop segments, reflections, the detailed wall and props)
// is the browser build's four presets (js/gfx.js TABLE / BUDGETS, each tuned
// to hold 60 FPS on the weakest GPU Auto gave it) keyed by the level's
// quality tier, with the dust motes and celebration particles scaled within
// the tier by the level's particle budget against the tier's anchor level
// (quantum, molecular, terrestrial, galactic), at most 4×. The runtime owns
// what the old Graphics panel did besides: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution and the frame-rate
// limit and readout. The old panel's per-category overrides are not offered
// (the runtime's Options choose a level). The refracting "transmission"
// flask glass of High and Ultra is clear glass on the engine (it draws no
// transmission).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Room-environment reflections on glass and brass. */
  reflections: boolean;
  /** Stone wall with relief, brass trim and corbels, the specimen flasks, the glass detail on the board. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed">;
const TABLE: Record<Preset, Art> = {
  low: { reflections: false, detailed: false },
  balanced: { reflections: true, detailed: true },
  high: { reflections: true, detailed: true },
  ultra: { reflections: true, detailed: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", woodTexture: 128, stoneTexture: 256, segments: 0.5, motes: 0, particles: 60 },
  balanced: { material: "standard", woodTexture: 256, stoneTexture: 256, segments: 0.75, motes: 24, particles: 160 },
  high: { material: "physical", woodTexture: 512, stoneTexture: 512, segments: 1, motes: 40, particles: 300 },
  ultra: { material: "physical", woodTexture: 512, stoneTexture: 1024, segments: 1.5, motes: 60, particles: 500 },
};
export const MOTE_CAP = 160;
export const PARTICLE_CAP = 1000;
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Counts grow with the level's particle budget above the tier's anchor,
  // at most four times the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.motes = Math.min(MOTE_CAP, Math.round(b.motes * k));
  b.particles = Math.min(PARTICLE_CAP, Math.round(b.particles * k));
  b.woodTexture = Math.min(b.woodTexture, s.maxTextureSize);
  b.stoneTexture = Math.min(b.stoneTexture, s.maxTextureSize);
  return {
    preset, ...TABLE[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
  };
}
