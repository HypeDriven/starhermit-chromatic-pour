// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json's event table: one per event) with the
// seeded ±4 % pitch variant per play (audioStream, so a replay sounds the
// same); the generative music on the A-minor pentatonic (a sine note every
// other half-second step, a fifth above it once the shelf is a third
// solved, a low pulse every two seconds past seven tenths) and the shelf
// theme's ambience (two detuned drones breathing under a slow tremolo over
// a filtered-noise room tone; five families: warm, cool, tidal, verdant,
// gilded).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the interface tick → "interface"; the old default
// bus levels (music 70 %, effects 90 %, ambience 50 %) are folded into each
// sound's gain. The music's notes and the ambience, which the browser build
// made with oscillators and filtered noise, are rendered once into clips
// (createClip) with the same envelopes; the ambience is a 20-second loop
// whose ends cross-fade. The synthesized stand-ins it played while a sample
// loaded are not ported (the engine's web runtime drops clip loads while a
// synthesis graph changes: the arrow-exodus finding). Clips load once the
// mixer runs (natively at once, in a browser after the first press), one at
// a time, and the rendered voices are made one a frame after them.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { audioStream, hashSeed } from "../js/rng.js";

const LEVEL = { music: 0.7, effects: 0.9, ambience: 0.5 };
const EVENTS = ["select", "deselect", "pour-start", "pour-end", "invalid", "layer-complete", "win", "fail", "undo", "ui", "hint", "tick", "achievement", "time-warning", "new-best"] as const;
export type SoundName = (typeof EVENTS)[number];
const INTERFACE = new Set<string>(["ui"]);
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0];

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

const rng = audioStream("chromatic-pour");
const musicRng = rng.fork("music");

/** Plays an event's sample (with the seeded pitch variant). */
export function play(name: SoundName, pitch = 1): void {
  const variant = 1 + (rng.next() - 0.5) * 0.08;
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects, pitch: Math.max(0.125, Math.min(8, pitch * variant)) }); }
  catch { clips.delete(name); load(name); } // a clip the mixer lost: load it again
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 22050;
/** js/audio.js shot(): 0 → `peak` linearly over `attack`, then exponentially to 0.0001 at `dur`. */
function env(t: number, peak: number, attack: number, dur: number): number {
  if (t < 0 || t >= dur) return 0;
  if (t < attack) return peak * (t / attack);
  return peak * Math.pow(0.0001 / peak, (t - attack) / Math.max(1e-6, dur - attack));
}
function toneClip(freq: number, dur: number, peak: number, attack: number, freqEnd = freq): AudioClip {
  const n = Math.round((dur + 0.05) * RATE);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = freqEnd === freq ? freq : freq * Math.pow(freqEnd / freq, Math.min(1, t / dur));
    ph += (2 * Math.PI * f) / RATE;
    out[i] = Math.sin(ph) * env(t, peak, attack, dur);
  }
  return createClip([out], RATE);
}

interface Family { base: number; type: "sine" | "triangle"; lfo: number; noiseHz: number; detune: number }
const FAMILY_DEFS: Record<string, Family> = {
  warm: { base: 110.0, type: "sine", lfo: 0.07, noiseHz: 400, detune: 4 },
  cool: { base: 146.8, type: "sine", lfo: 0.05, noiseHz: 900, detune: 6 },
  tidal: { base: 98.0, type: "triangle", lfo: 0.11, noiseHz: 600, detune: 5 },
  verdant: { base: 130.8, type: "triangle", lfo: 0.08, noiseHz: 1200, detune: 7 },
  gilded: { base: 164.8, type: "sine", lfo: 0.06, noiseHz: 2000, detune: 3 },
};
const FAMILIES = ["warm", "cool", "tidal", "verdant", "gilded"];
function familyFor(themeId: string): string {
  const s = String(themeId ?? "").toLowerCase();
  if (FAMILY_DEFS[s]) return s;
  return FAMILIES[hashSeed(s) % FAMILIES.length]!;
}
/** js/audio.js buildAmbience(): the drones (gain 0.6 and 0.25, each breathing ±0.15 at its LFO) and the room tone (noise lowpassed at the family's frequency, 0.05), all at 0.1. */
function ambienceClip(family: string): AudioClip {
  const def = FAMILY_DEFS[family]!;
  const rate = 11025;
  const len = 20, fade = 2;
  const n = (len + fade) * rate;
  const raw = new Float32Array(n);
  const r = musicRng.fork("amb:" + family);
  const wave = (ph: number): number => (def.type === "sine" ? Math.sin(ph) : (2 / Math.PI) * Math.asin(Math.sin(ph)));
  for (const [mult, gain, lfoMul] of [[1, 0.6, 1], [1.5, 0.25, 1.7]] as const) {
    const f = def.base * mult * Math.pow(2, ((r.next() - 0.5) * 2 * def.detune) / 1200);
    const lf = def.lfo * lfoMul;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      raw[i]! += wave(2 * Math.PI * f * t) * (gain + 0.15 * Math.sin(2 * Math.PI * lf * t));
    }
  }
  // RBJ biquad lowpass, Q 1, over white noise
  const w = (2 * Math.PI * Math.min(def.noiseHz, rate * 0.45)) / rate, alpha = Math.sin(w) / 2, c = Math.cos(w), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const nr = r.fork("noise");
  for (let i = 0; i < n; i++) {
    const x0 = nr.next() * 2 - 1;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    raw[i]! += y0 * 0.05;
  }
  const out = new Float32Array(len * rate);
  for (let i = 0; i < out.length; i++) {
    let v = raw[i]!;
    if (i < fade * rate) { const k = i / (fade * rate); v = v * k + raw[len * rate + i]! * (1 - k); }
    out[i] = v * 0.1;
  }
  return createClip([out], rate);
}

const melody = new Map<number, AudioClip>();
const harmony = new Map<number, AudioClip>();
let pulse: AudioClip | null = null;
const ambClips = new Map<string, AudioClip>();
/** One rendered voice a frame, once the samples are in; false when all are made. */
function renderNext(): boolean {
  for (let i = 0; i < SCALE.length; i++) if (!melody.has(i)) { melody.set(i, toneClip(SCALE[i]!, 1.4, 0.05, 0.02)); return true; }
  for (let i = 0; i < SCALE.length; i++) if (!harmony.has(i)) { harmony.set(i, toneClip(SCALE[i]! * 1.5, 1.2, 0.03, 0.05)); return true; }
  if (!pulse) { pulse = toneClip(110, 0.18, 0.06, 0.002, 70); return true; }
  if (ambFamily && !ambClips.has(ambFamily)) { ambClips.set(ambFamily, ambienceClip(ambFamily)); return true; }
  return false;
}

// -- music and ambience -------------------------------------------------------------------
let intensity = 0;
let nextStep = 0;
let step = 0;
let ambFamily: string | null = null;
let ambSound: Sound | null = null;
let ambPlaying: string | null = null;
let paused = false;

/** 0–1: the shelf's completion; layers fade in with it. */
export function setMusicIntensity(v: number): void { intensity = Math.max(0, Math.min(1, Number(v) || 0)); }
export function startAmbience(themeId: string): void { ambFamily = familyFor(themeId); }
export function stopAmbience(): void {
  ambFamily = null;
  fadeOutAmbience(1.2);
}
function fadeOutAmbience(seconds: number): void {
  if (!ambSound) return;
  const s = ambSound;
  ambSound = null;
  ambPlaying = null;
  try { s.fade(0, seconds); setTimeout(() => { try { s.stop(); } catch { /* gone */ } }, seconds * 1000 + 100); } catch { /* gone */ }
}
/** The window was hidden (the browser build suspended its audio context). */
export function setPaused(on: boolean): void { paused = on; }

function voice(clip: AudioClip | undefined, bus: Bus, gain: number): void {
  if (!clip) return;
  try { playClip(clip, { bus, gain }); } catch { /* the mixer is full */ }
}

/** Each frame: the samples once the mixer runs, one rendered voice a frame,
 * then the music's steps and the ambience's loop by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of EVENTS) load(name);
  }
  pump();
  if (loading || queue.length) return;
  try { if (renderNext()) return; } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  const now = context.currentTime;
  // ambience (a family change cross-fades)
  if (ambFamily !== ambPlaying) {
    fadeOutAmbience(1.2);
    const clip = ambFamily ? ambClips.get(ambFamily) : undefined;
    if (clip && ambFamily) {
      try { ambSound = playClip(clip, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade(LEVEL.ambience, 1.5); ambPlaying = ambFamily; }
      catch { ambSound = null; }
    }
  }
  // music: eighth notes at 60 bpm
  if (paused) { if (nextStep < now) nextStep = now; return; }
  if (nextStep === 0 || now - nextStep > 1) nextStep = now + 0.2;
  if (now < nextStep) return;
  if (step % 2 === 0 && musicRng.next() > 0.25) {
    const i = Math.floor(musicRng.next() * SCALE.length);
    voice(melody.get(i), "music", LEVEL.music);
    if (intensity >= 0.35) voice(harmony.get(i), "music", LEVEL.music * Math.min(1, intensity + 0.3));
  }
  if (intensity >= 0.7 && step % 4 === 0) voice(pulse ?? undefined, "music", LEVEL.music);
  nextStep += 0.5;
  step++;
}
