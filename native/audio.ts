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
// sound's gain. The music's notes and the ambience are offline graphs rendered
// once into clips with the same envelopes; the ambience is a 20-second loop
// whose ends cross-fade. The synthesized stand-ins the browser build played
// while a sample loaded are not ported. The clips load and the notes render at
// once in onStart, a family's ambience when it is first asked for; the sound
// starts once the mixer runs (in a browser after the first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { audioStream, hashSeed } from "../js/rng.js";

const LEVEL = { music: 0.7, effects: 0.9, ambience: 0.5 };
const EVENTS = ["select", "deselect", "pour-start", "pour-end", "invalid", "layer-complete", "win", "fail", "undo", "ui", "hint", "tick", "achievement", "time-warning", "new-best"] as const;
export type SoundName = (typeof EVENTS)[number];
const INTERFACE = new Set<string>(["ui"]);
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0];

const clips = new Map<string, AudioClip>();
/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of EVENTS) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  void renderVoices().catch((e: unknown) => console.warn(`audio: ${String(e)}`));
}

const rng = audioStream("chromatic-pour");
const musicRng = rng.fork("music");

/** Plays an event's sample (with the seeded pitch variant). */
export function play(name: SoundName, pitch = 1): void {
  const variant = 1 + (rng.next() - 0.5) * 0.08;
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects, pitch: Math.max(0.125, Math.min(8, pitch * variant)) }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 22050;
/** js/audio.js shot(): 0 → `peak` linearly over `attack`, then exponentially to 0.0001 at `dur`. */
async function renderTone(freq: number, dur: number, peak: number, attack: number, freqEnd = freq): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round((dur + 0.05) * RATE), RATE);
  const osc = off.createOscillator();
  osc.frequency.setValueAtTime(freq, 0);
  if (freqEnd !== freq) osc.frequency.exponentialRampToValueAtTime(freqEnd, dur);
  const g = off.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(peak, attack);
  g.gain.exponentialRampToValueAtTime(0.0001, dur);
  osc.connect(g).connect(off.destination);
  osc.start();
  osc.stop(dur);
  return createClip(await off.startRendering());
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
async function renderAmbience(family: string): Promise<AudioClip> {
  const def = FAMILY_DEFS[family]!;
  const rate = 11025;
  const len = 20, fade = 2;
  const off = new OfflineAudioContext(1, (len + fade) * rate, rate);
  const master = off.createGain();
  master.gain.value = 0.1;
  master.connect(off.destination);
  const r = musicRng.fork("amb:" + family);
  for (const [mult, gain, lfoMul] of [[1, 0.6, 1], [1.5, 0.25, 1.7]] as const) {
    const osc = off.createOscillator();
    osc.type = def.type;
    osc.frequency.value = def.base * mult * Math.pow(2, ((r.next() - 0.5) * 2 * def.detune) / 1200);
    const g = off.createGain();
    g.gain.value = gain;
    const lfo = off.createOscillator();
    lfo.frequency.value = def.lfo * lfoMul;
    const depth = off.createGain();
    depth.gain.value = 0.15;
    lfo.connect(depth).connect(g.gain);
    osc.connect(g).connect(master);
    osc.start();
    lfo.start();
  }
  const noise = off.createNoise({ seed: hashSeed(family), seconds: len + fade });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Math.min(def.noiseHz, rate * 0.45);
  const room = off.createGain();
  room.gain.value = 0.05;
  noise.connect(lp).connect(room).connect(master);
  noise.start();
  const raw = (await off.startRendering()).getChannelData(0);
  const out = new Float32Array(len * rate);
  for (let i = 0; i < out.length; i++) {
    let v = raw[i]!;
    if (i < fade * rate) { const k = i / (fade * rate); v = v * k + raw[len * rate + i]! * (1 - k); }
    out[i] = v;
  }
  return createClip([out], rate);
}

const melody = new Map<number, AudioClip>();
const harmony = new Map<number, AudioClip>();
let pulse: AudioClip | null = null;
const ambClips = new Map<string, AudioClip>();
const ambRendering = new Set<string>();
/** Every note, one graph at a time; the pulse last, as update() waits on it. */
async function renderVoices(): Promise<void> {
  for (let i = 0; i < SCALE.length; i++) melody.set(i, await renderTone(SCALE[i]!, 1.4, 0.05, 0.02));
  for (let i = 0; i < SCALE.length; i++) harmony.set(i, await renderTone(SCALE[i]! * 1.5, 1.2, 0.03, 0.05));
  pulse = await renderTone(110, 0.18, 0.06, 0.002, 70);
}
function renderFamily(family: string): void {
  if (ambClips.has(family) || ambRendering.has(family)) return;
  ambRendering.add(family);
  renderAmbience(family).then((c) => { ambClips.set(family, c); }, (e: unknown) => console.warn(`audio: ${String(e)}`));
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
export function startAmbience(themeId: string): void { ambFamily = familyFor(themeId); renderFamily(ambFamily); }
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

/** Each frame once the mixer runs and the notes are rendered: the music's steps and the ambience's loop by mixer time. */
export function update(): void {
  if (context.state !== "running" || !pulse) return;
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
  if (intensity >= 0.7 && step % 4 === 0) voice(pulse, "music", LEVEL.music);
  nextStep += 0.5;
  step++;
}
