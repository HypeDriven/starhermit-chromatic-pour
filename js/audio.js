// audio.js — WebAudio engine: procedural music/ambience/synthesis with authored
// sample one-shots (sfx/manifest.json + sfx/<name>.opus) preferred per event
// once loaded; synthesis remains the fallback. Lazy AudioContext, bused gains,
// seeded pitch variants (audioStream) so replays sound identical.
// Browser-only; if WebAudio is unavailable every export degrades to a no-op.

import { audioStream, hashSeed } from './rng.js';

const BUS_NAMES = ['music', 'effects', 'ambience', 'voice'];

const AMBIENCE_FAMILIES = ['warm', 'cool', 'tidal', 'verdant', 'gilded'];
const FAMILY_DEFS = {
  warm:    { base: 110.0, type: 'sine',     lfo: 0.07, noiseHz: 400,  detune: 4 },
  cool:    { base: 146.8, type: 'sine',     lfo: 0.05, noiseHz: 900,  detune: 6 },
  tidal:   { base: 98.0,  type: 'triangle', lfo: 0.11, noiseHz: 600,  detune: 5 },
  verdant: { base: 130.8, type: 'triangle', lfo: 0.08, noiseHz: 1200, detune: 7 },
  gilded:  { base: 164.8, type: 'sine',     lfo: 0.06, noiseHz: 2000, detune: 3 },
};

// Original A-minor pentatonic motif pool for the generative music loop.
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0];

function familyFor(themeId) {
  const s = String(themeId ?? '').toLowerCase();
  if (FAMILY_DEFS[s]) return s;
  return AMBIENCE_FAMILIES[hashSeed(s) % AMBIENCE_FAMILIES.length];
}

function makeNoop() {
  const f = () => {};
  return {
    unlock: f, setVolume: f, play: f, startAmbience: f, stopAmbience: f,
    setMusicIntensity: f, setMuted: f, suspend: f, resume: f, dispose: f,
  };
}

export function createAudio(settings = {}, { audioSeed = 'default' } = {}) {
  let AC = null;
  try {
    if (typeof window !== 'undefined') AC = window.AudioContext || window.webkitAudioContext;
  } catch {
    AC = null;
  }
  if (!AC) return makeNoop();

  let ctx = null;
  let master = null;
  const buses = {};
  let noiseBuf = null;
  let disposed = false;
  let muted = false;
  let masterGain = 1;

  const rng = audioStream(audioSeed);      // per-play pitch variants
  const musicRng = rng.fork('music');      // generative motif stream

  const volumes = {
    music: num(settings.music, 0.7), effects: num(settings.effects, 0.9),
    ambience: num(settings.ambience, 0.5), voice: num(settings.voice, 0.8),
  };

  let pendingTheme = null;                 // ambience requested before unlock
  let ambienceState = null;                // {family, gain, nodes, lfos}
  let musicTimer = null;
  let musicStep = 0;
  let musicNextTime = 0;
  let intensity = 0;

  function num(v, d) {
    return typeof v === 'number' && v >= 0 && v <= 1 ? v : d;
  }

  function makeNoiseBuffer() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const noiseRng = rng.fork('noise');
    for (let i = 0; i < len; i++) data[i] = noiseRng.next() * 2 - 1;
    return buf;
  }

  // One-shot envelope helper. build(dest, t0) wires sources into `dest`;
  // everything is stopped at t0+dur and disconnected on ended (no leaks).
  function shot({ at = 0, dur = 0.5, peak = 0.2, attack = 0.005, bus = 'effects', curve = 'exp', build }) {
    const t0 = ctx.currentTime + at;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    if (curve === 'exp') {
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    } else {
      g.gain.linearRampToValueAtTime(0, t0 + dur);
    }
    g.connect(buses[bus]);
    const sources = build(g, t0) || [];
    for (const s of sources) {
      try { s.stop(t0 + dur + 0.05); } catch { /* already stopped */ }
      s.onended = () => { try { g.disconnect(); } catch { /* gone */ } };
    }
    return g;
  }

  function tone({ freq, freqEnd, type = 'sine', ...rest }) {
    return shot({
      ...rest,
      build(dest, t0) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + rest.dur);
        o.connect(dest);
        o.start(t0);
        return [o];
      },
    });
  }

  function noise({ filterType = 'lowpass', filterFreq = 1000, filterEnd, q = 1, ...rest }) {
    return shot({
      ...rest,
      build(dest, t0) {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.setValueAtTime(filterFreq, t0);
        if (filterEnd) f.frequency.exponentialRampToValueAtTime(filterEnd, t0 + rest.dur);
        f.Q.value = q;
        src.connect(f);
        f.connect(dest);
        src.start(t0);
        return [src];
      },
    });
  }

  // ---------------------------------------------------------------- sounds

  const SOUNDS = {
    'select': (p) => {
      tone({ freq: 1200 * p, dur: 0.18, peak: 0.15 });
      tone({ freq: 2400 * p, dur: 0.1, peak: 0.04 });
    },
    'deselect': (p) => {
      tone({ freq: 880 * p, dur: 0.15, peak: 0.11 });
    },
    'pour-start': (p) => {
      noise({ filterFreq: 400 * p, filterEnd: 1800 * p, dur: 0.6, peak: 0.22, attack: 0.25, curve: 'lin' });
      tone({ freq: 500 * p, freqEnd: 260 * p, dur: 0.5, peak: 0.08 });
    },
    'pour-end': (p) => {
      tone({ freq: 620 * p, dur: 0.09, peak: 0.13, type: 'sine' });
    },
    'invalid': (p) => {
      // dull wooden thunk: low triangle through a lowpass, no harsh buzz
      tone({ freq: 180 * p, dur: 0.12, peak: 0.22, type: 'triangle', attack: 0.002 });
      noise({ filterFreq: 300, dur: 0.07, peak: 0.08, attack: 0.002 });
    },
    'layer-complete': (p) => {
      tone({ freq: 660 * p, dur: 0.45, peak: 0.12, type: 'triangle' });
      tone({ freq: 880 * p, dur: 0.5, peak: 0.12, type: 'triangle', at: 0.12 });
    },
    'win': (p) => {
      const motif = [523.25, 587.33, 659.25, 783.99, 1046.5];
      motif.forEach((f, i) => {
        tone({ freq: f * p, dur: 0.5, peak: 0.14, type: 'triangle', at: i * 0.11 });
        tone({ freq: f * 2 * p, dur: 0.35, peak: 0.03, at: i * 0.11 });
      });
      // shimmer: faint high noise tail
      noise({ filterType: 'highpass', filterFreq: 6000, dur: 1.2, peak: 0.02, attack: 0.3 });
    },
    'fail': (p) => {
      tone({ freq: 330 * p, dur: 0.4, peak: 0.13, type: 'triangle' });
      tone({ freq: 246.9 * p, dur: 0.6, peak: 0.13, type: 'triangle', at: 0.28 });
    },
    'undo': (p) => {
      // reversed-feel swoosh: rising bandpass, crescendo then abrupt release
      noise({ filterType: 'bandpass', filterFreq: 300 * p, filterEnd: 1500 * p, q: 2, dur: 0.22, peak: 0.16, attack: 0.18, curve: 'lin' });
    },
    'ui': (p) => {
      tone({ freq: 1800 * p, dur: 0.03, peak: 0.06, attack: 0.001 });
    },
    'hint': (p) => {
      tone({ freq: 1567 * p, dur: 0.25, peak: 0.05 });
      tone({ freq: 2093 * p, dur: 0.3, peak: 0.05, at: 0.07 });
    },
    'tick': (p) => {
      noise({ filterType: 'bandpass', filterFreq: 2000 * p, q: 8, dur: 0.04, peak: 0.1, attack: 0.001 });
      tone({ freq: 1000 * p, dur: 0.03, peak: 0.04, attack: 0.001 });
    },
  };

  // ---------------------------------------------------------------- sample sfx
  // Authored one-shots (sfx/manifest.json + sfx/<name>.opus) take priority
  // over the synthesized fallbacks above once fetched and decoded. Loading
  // starts only after unlock() (user gesture); any failure keeps synthesis.

  const sampleBuffers = new Map();   // basename -> AudioBuffer
  const sampleLoads = new Map();     // basename -> in-flight Promise (dedupe)
  const sampleFailed = new Set();    // basename -> never retry
  let eventSamples = null;           // event name -> clip basename
  let manifestRequested = false;

  async function loadManifest() {
    try {
      const res = await fetch('sfx/manifest.json');
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list)) return;
      const map = {};
      for (const item of list) {
        if (item && typeof item.name === 'string' && typeof item.event === 'string' &&
            SOUNDS[item.event] && !(item.event in map)) {
          map[item.event] = item.name;
        }
      }
      eventSamples = map;
    } catch { /* no manifest -> synthesis only */ }
  }

  function requestSample(name) {
    if (sampleBuffers.has(name) || sampleFailed.has(name) || sampleLoads.has(name)) return;
    const p = (async () => {
      try {
        const res = await fetch(`sfx/${name}.opus`);
        if (!res.ok) throw new Error('missing sample');
        sampleBuffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        sampleFailed.add(name);
      } finally {
        sampleLoads.delete(name);
      }
    })();
    sampleLoads.set(name, p);
  }

  function playSample(name, pitch) {
    const buf = sampleBuffers.get(name);
    if (!buf) return false;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      src.connect(buses.effects);
      src.onended = () => { try { src.disconnect(); } catch { /* gone */ } };
      src.start();
      return true;
    } catch { /* fall through to synthesis */ }
    return false;
  }

  // ---------------------------------------------------------------- ambience

  function buildAmbience(family) {
    const def = FAMILY_DEFS[family];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 1.5);
    g.connect(buses.ambience);
    const nodes = [];
    const lfos = [];
    for (const mult of [1, 1.5]) {
      const o = ctx.createOscillator();
      o.type = def.type;
      o.frequency.value = def.base * mult;
      o.detune.value = (musicRng.next() - 0.5) * 2 * def.detune;
      const og = ctx.createGain();
      og.gain.value = mult === 1 ? 0.6 : 0.25;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = def.lfo * (mult === 1 ? 1 : 1.7);
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.15;
      lfo.connect(lfoGain);
      lfoGain.connect(og.gain);
      o.connect(og);
      og.connect(g);
      o.start();
      lfo.start();
      nodes.push(o);
      lfos.push(lfo);
    }
    // faint filtered-noise "room tone"
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = def.noiseHz;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    src.connect(f);
    f.connect(ng);
    ng.connect(g);
    src.start();
    nodes.push(src);
    return { family, gain: g, nodes, lfos };
  }

  function killAmbience(state, fade = 1.2) {
    if (!state) return;
    const t = ctx.currentTime;
    try {
      state.gain.gain.cancelScheduledValues(t);
      state.gain.gain.setValueAtTime(state.gain.gain.value, t);
      state.gain.gain.linearRampToValueAtTime(0, t + fade);
    } catch { /* gone */ }
    const nodes = [...state.nodes, ...state.lfos];
    setTimeout(() => {
      for (const n of nodes) { try { n.stop(); } catch { /* stopped */ } }
      try { state.gain.disconnect(); } catch { /* gone */ }
    }, fade * 1000 + 100);
  }

  // ---------------------------------------------------------------- music

  function scheduleMusic() {
    if (!ctx || ctx.state !== 'running') return;
    const stepDur = 0.5; // eighth notes at 60bpm: slow, calm
    while (musicNextTime < ctx.currentTime + 0.6) {
      const t = musicNextTime;
      const step = musicStep;
      // sparse melody: a note every other step, occasionally resting
      if (step % 2 === 0 && musicRng.next() > 0.25) {
        const f = musicRng.pick(SCALE);
        tone({ freq: f, dur: 1.4, peak: 0.05, attack: 0.02, bus: 'music', at: t - ctx.currentTime });
        // harmony layer fades in with completion progress
        if (intensity >= 0.35) {
          tone({ freq: f * 1.5, dur: 1.2, peak: 0.03 * Math.min(1, intensity + 0.3), attack: 0.05, bus: 'music', at: t - ctx.currentTime });
        }
      }
      // gentle pulse on the beat at high intensity
      if (intensity >= 0.7 && step % 4 === 0) {
        tone({ freq: 110, freqEnd: 70, dur: 0.18, peak: 0.06, attack: 0.002, bus: 'music', at: t - ctx.currentTime });
      }
      musicNextTime += stepDur;
      musicStep += 1;
    }
  }

  function startMusic() {
    if (musicTimer || !ctx) return;
    musicNextTime = ctx.currentTime + 0.2;
    musicTimer = setInterval(scheduleMusic, 250);
  }

  // ---------------------------------------------------------------- public

  function unlock() {
    if (disposed) return;
    if (!ctx) {
      try {
        ctx = new AC();
      } catch {
        ctx = null;
        return;
      }
      master = ctx.createGain();
      master.gain.value = muted ? 0 : masterGain;
      master.connect(ctx.destination);
      for (const name of BUS_NAMES) {
        const g = ctx.createGain();
        g.gain.value = volumes[name];
        g.connect(master);
        buses[name] = g;
      }
      noiseBuf = makeNoiseBuffer();
      if (!manifestRequested) {
        manifestRequested = true;
        loadManifest();
      }
      startMusic();
      if (pendingTheme != null) {
        const theme = pendingTheme;
        pendingTheme = null;
        api.startAmbience(theme);
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  const api = {
    unlock,

    setVolume(bus, v) {
      if (!(bus in volumes) || typeof v !== 'number') return;
      volumes[bus] = Math.max(0, Math.min(1, v));
      if (buses[bus] && ctx) {
        buses[bus].gain.setTargetAtTime(volumes[bus], ctx.currentTime, 0.02);
      }
    },

    play(name, { pitch = 1 } = {}) {
      if (!ctx || ctx.state !== 'running' || disposed) return;
      const fn = SOUNDS[name];
      if (!fn) return;
      // seeded variant so a replayed session produces identical audio
      const variant = 1 + (rng.next() - 0.5) * 0.08;
      const p = (typeof pitch === 'number' && pitch > 0 ? pitch : 1) * variant;
      // Prefer the authored sample; synthesize only while it loads or if it failed.
      const clip = eventSamples && eventSamples[name];
      if (clip) {
        requestSample(clip);
        if (playSample(clip, p)) return;
      }
      try {
        fn(p);
      } catch { /* a failed one-shot must never break the game */ }
    },

    startAmbience(themeId) {
      if (disposed) return;
      if (!ctx) { pendingTheme = themeId; return; }
      const family = familyFor(themeId);
      if (ambienceState && ambienceState.family === family) return;
      killAmbience(ambienceState);
      ambienceState = buildAmbience(family);
    },

    stopAmbience() {
      pendingTheme = null;
      if (!ctx) return;
      killAmbience(ambienceState);
      ambienceState = null;
    },

    setMusicIntensity(v) {
      intensity = typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0;
    },

    setMuted(m) {
      muted = !!m;
      if (master && ctx) {
        if (!muted) masterGain = 1;
        master.gain.setTargetAtTime(muted ? 0 : masterGain, ctx.currentTime, 0.01);
      }
    },

    suspend() {
      if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    },

    resume() {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    },

    dispose() {
      disposed = true;
      if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
      sampleBuffers.clear();
      sampleLoads.clear();
      sampleFailed.clear();
      eventSamples = null;
      manifestRequested = false;
      if (ctx) {
        killAmbience(ambienceState, 0.05);
        ambienceState = null;
        ctx.close().catch(() => {});
        ctx = null;
      }
    },
  };

  return api;
}
