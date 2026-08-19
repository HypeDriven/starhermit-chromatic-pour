// rng.js — deterministic seeded random streams.
// Rules, decoration, and audio each get independent sub-streams so cosmetic
// randomness can never perturb rules outcomes.

export function hashSeed(str) {
  // xmur3
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function createRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 0x9e3779b9;
  // mulberry32
  function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const rng = {
    next,
    int(minInc, maxInc) {
      return minInc + Math.floor(next() * (maxInc - minInc + 1));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    fork(tag) {
      return createRng(hashSeed(`${a >>> 0}:${String(tag)}`));
    },
  };
  return rng;
}

export function rulesStream(seed) { return createRng(hashSeed(`rules:${seed}`)); }
export function decorStream(seed) { return createRng(hashSeed(`decor:${seed}`)); }
export function audioStream(seed) { return createRng(hashSeed(`audio:${seed}`)); }
