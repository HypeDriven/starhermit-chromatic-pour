// content.js — versioned game content: color sets, themes, difficulties,
// lessons, journey, challenges, daily/practice generators, and offline
// content validation. Pure data + rules; Node-safe (no DOM, no Date at
// import time).

import * as rules from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Color sets — 5 palettes x 10 colors. Each color carries a distinct shape
// token so color is never the only channel (accessibility contract).
// ---------------------------------------------------------------------------

const SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star', 'drop', 'hexagon', 'moon', 'wave', 'bolt'];

function palette(rows) {
  if (rows.length !== 10) throw new Error('palette must define exactly 10 colors');
  return rows.map(([id, name, hex], i) => ({ id, name, hex, shape: SHAPES[i] }));
}

export const COLOR_SETS = {
  // Vibrant default shelf.
  standard: palette([
    ['emberwine', 'Emberwine', '#D6402B'],
    ['cinnabar', 'Cinnabar', '#E8830C'],
    ['sungilt', 'Sungilt', '#EFC618'],
    ['malachite', 'Malachite', '#3FA34D'],
    ['verdigris', 'Verdigris', '#2AA198'],
    ['azurite', 'Azurite', '#2B6CB0'],
    ['amethyne', 'Amethyne', '#6C4AB0'],
    ['orchil', 'Orchil', '#C94F8A'],
    ['umberdeep', 'Umberdeep', '#8B5A2B'],
    ['mistveil', 'Mistveil', '#9AA5B1'],
  ]),
  // Deuteranopia-safe (Okabe-Ito base, extended with Tol bright tones).
  deuteranopia: palette([
    ['deepcobalt', 'Deepcobalt', '#0072B2'],
    ['honeymere', 'Honeymere', '#E69F00'],
    ['glassfern', 'Glassfern', '#009E73'],
    ['lanternmoth', 'Lanternmoth', '#F0E442'],
    ['rainflask', 'Rainflask', '#56B4E9'],
    ['kilnfire', 'Kilnfire', '#D55E00'],
    ['silkmallow', 'Silkmallow', '#CC79A7'],
    ['nightink', 'Nightink', '#332288'],
    ['frostbreath', 'Frostbreath', '#88CCEE'],
    ['pewtervein', 'Pewtervein', '#999999'],
  ]),
  // Protanopia-safe (Okabe-Ito family, shifted accents).
  protanopia: palette([
    ['gulfblue', 'Gulfblue', '#1B6CA8'],
    ['ochrefall', 'Ochrefall', '#E08214'],
    ['copperfern', 'Copperfern', '#1B9E77'],
    ['brassglow', 'Brassglow', '#E9D24A'],
    ['mistglass', 'Mistglass', '#5AA9DC'],
    ['rustpyre', 'Rustpyre', '#C7511D'],
    ['woadbloom', 'Woadbloom', '#BC7BB0'],
    ['inkdusk', 'Inkdusk', '#3B2E7A'],
    ['shallowice', 'Shallowice', '#9AD1E0'],
    ['quarrydust', 'Quarrydust', '#8C8C8C'],
  ]),
  // Tritanopia-safe: separated along the red<->teal axis plus luminance steps.
  tritanopia: palette([
    ['wineshadow', 'Wineshadow', '#8E0038'],
    ['dragonblood', 'Dragonblood', '#D62728'],
    ['coralfire', 'Coralfire', '#F06548'],
    ['petaldrift', 'Petaldrift', '#F2A7C3'],
    ['duskplum', 'Duskplum', '#5B1F4F'],
    ['deepkelp', 'Deepkelp', '#0B5563'],
    ['lagoonheart', 'Lagoonheart', '#15918B'],
    ['frostmint', 'Frostmint', '#54C6A5'],
    ['coalscript', 'Coalscript', '#2A2A2A'],
    ['silverash', 'Silverash', '#CFCFCF'],
  ]),
  // Maximum channel separation for high-contrast mode.
  contrast: palette([
    ['pureflame', 'Pureflame', '#E50000'],
    ['sunshard', 'Sunshard', '#FFD500'],
    ['truesapphire', 'Truesapphire', '#0047FF'],
    ['sharpfern', 'Sharpfern', '#00A53F'],
    ['bloomshock', 'Bloomshock', '#FF6EC7'],
    ['violetarc', 'Violetarc', '#7A00E6'],
    ['icerill', 'Icerill', '#00C2C7'],
    ['blazepeel', 'Blazepeel', '#FF7A00'],
    ['voidcoal', 'Voidcoal', '#101010'],
    ['saltwhite', 'Saltwhite', '#F5F5F5'],
  ]),
};

// ---------------------------------------------------------------------------
// Themes — alchemist-shelf visual identities. bg/fog/shelf/accent are consumed
// by both CSS and the Three.js scene.
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    id: 'ember', name: 'Ember Atelier', palette: 'standard',
    blurb: 'A warm workbench over slow coals; every draught glows like a banked fire.',
    bg: '#1A0F0A', fog: '#3A1D12', shelf: '#6B4226', accent: '#FF9E4A', ambience: 'warm',
  },
  {
    id: 'tidal', name: 'Tidal Sanctum', palette: 'standard',
    blurb: 'Glassware rinsed by cold seawater light, deep below a drowned observatory.',
    bg: '#0A1620', fog: '#123043', shelf: '#2E5A6B', accent: '#5AD1E6', ambience: 'cool',
  },
  {
    id: 'grove', name: 'Verdigris Conservatory', palette: 'standard',
    blurb: 'A vine-choked greenhouse where tinctures steep in bottled sunlight.',
    bg: '#0D1A10', fog: '#1C3524', shelf: '#3E5A34', accent: '#8FD65A', ambience: 'verdant',
  },
  {
    id: 'umbra', name: 'Gloaming Reliquary', palette: 'standard',
    blurb: 'A vaulted crypt of quiet vials, lit only by what the liquids remember.',
    bg: '#0C0A14', fog: '#1E1830', shelf: '#3A3050', accent: '#A78BFA', ambience: 'dusk',
  },
  {
    id: 'aurum', name: 'Gilded Orrery', palette: 'standard',
    blurb: 'Brass rings and radiant glass at the top of the alchemist\u2019s tower.',
    bg: '#171207', fog: '#33270E', shelf: '#6B5320', accent: '#F2C14E', ambience: 'radiant',
  },
];

// ---------------------------------------------------------------------------
// Difficulties (practice mode)
// ---------------------------------------------------------------------------

export const DIFFICULTIES = [
  { id: 'apprentice', label: 'Apprentice', colorCount: 4, emptyVessels: 2, desc: 'Four tinctures and generous glassware. Learn the pour.' },
  { id: 'journeyman', label: 'Journeyman', colorCount: 6, emptyVessels: 2, desc: 'Six tinctures; the shelf starts to crowd.' },
  { id: 'adept', label: 'Adept', colorCount: 8, emptyVessels: 2, desc: 'Eight tinctures demanding real forethought.' },
  { id: 'master', label: 'Master', colorCount: 10, emptyVessels: 2, desc: 'The full decalogue of colors. No wasted motion.' },
];

// ---------------------------------------------------------------------------
// Lessons — interactive; each step requires the player to perform the action.
// Explicit vessel setups keep lessons deterministic and the required move
// legal (or deliberately illegal, where the lesson is the refusal itself).
// ---------------------------------------------------------------------------

const L1_SETUP = { seed: 'lesson-1', colorCount: 2, emptyVessels: 2, vessels: [[0, 1, 0], [1, 0, 1], [], []] };
const L2_SETUP = { seed: 'lesson-2', colorCount: 2, emptyVessels: 1, vessels: [[0, 1], [0, 0], [1], []] };
const L3_SETUP = { seed: 'lesson-3', colorCount: 2, emptyVessels: 2, vessels: [[0, 0, 1, 1], [1, 1, 0, 0], [], []] };
const L4_SETUP = { seed: 'lesson-4', colorCount: 2, emptyVessels: 2, vessels: [[0, 1, 0, 1], [1, 0, 1, 0], [], []] };
const L5_SETUP = { seed: 'lesson-5', colorCount: 2, emptyVessels: 2, vessels: [[0, 1], [1, 0], [], []] };

export const LESSONS = [
  {
    id: 'lesson-first-pour', title: 'The First Decant',
    steps: [
      {
        text: 'Vessels hold layers of liquid, bottom to top. Lift one by selecting it — select the first vessel.',
        setup: L1_SETUP,
        require: { kind: 'select', from: 0 },
        hintText: 'Tap or focus vessel 1 and confirm to lift it.',
      },
      {
        text: 'Now pour into the empty vessel. Empty glass accepts any color.',
        setup: L1_SETUP,
        require: { kind: 'pour', from: 0, to: 2 },
        hintText: 'With vessel 1 lifted, select the first empty vessel.',
      },
      {
        text: 'Well poured. Pour the second vessel\u2019s top layer anywhere it is legal.',
        setup: L1_SETUP,
        require: { kind: 'pour-color', color: 1 },
        hintText: 'Vessel 2\u2019s top layer can go into the remaining empty glass.',
      },
    ],
  },
  {
    id: 'lesson-matching', title: 'Like Seeks Like',
    steps: [
      {
        text: 'Select the first vessel. Watch its top layer — that is the color that will move.',
        setup: L2_SETUP,
        require: { kind: 'select', from: 0 },
        hintText: 'Lift vessel 1.',
      },
      {
        text: 'A layer may only land on a matching color or in empty glass. Try pouring vessel 1 onto vessel 2 and read the shelf\u2019s refusal.',
        setup: L2_SETUP,
        require: { kind: 'pour', from: 0, to: 1 },
        hintText: 'Attempt the pour onto vessel 2 — the colors disagree, and the shelf will say so.',
      },
      {
        text: 'Now do it properly: pour vessel 1 onto the matching color in vessel 3.',
        setup: L2_SETUP,
        require: { kind: 'pour', from: 0, to: 2 },
        hintText: 'Vessel 3\u2019s top layer matches — pour there.',
      },
    ],
  },
  {
    id: 'lesson-contiguous', title: 'Layers Travel Together',
    steps: [
      {
        text: 'Contiguous layers of one color pour as a single unit. Vessel 1 carries two matching layers on top — pour them into the empty glass.',
        setup: L3_SETUP,
        require: { kind: 'pour', from: 0, to: 2 },
        hintText: 'Lift vessel 1, then pour into vessel 3; both layers move at once.',
      },
      {
        text: 'Runs settle as one. Finish the other color the same way: pour vessel 2 onto vessel 1.',
        setup: L3_SETUP,
        require: { kind: 'pour', from: 1, to: 0 },
        hintText: 'Vessel 2\u2019s top run matches vessel 1\u2019s color — combine them.',
      },
    ],
  },
  {
    id: 'lesson-planning', title: 'The Empty Glass',
    steps: [
      {
        text: 'Empty vessels are your workspace. Park the top layer of vessel 1 in an empty glass to reach what lies beneath. Pour the first color anywhere legal.',
        setup: L4_SETUP,
        require: { kind: 'pour-color', color: 1 },
        hintText: 'The top of vessel 1 is color two — park it in either empty vessel.',
      },
      {
        text: 'Now the layer beneath is free. Pour the other color anywhere legal.',
        setup: L4_SETUP,
        require: { kind: 'pour-color', color: 0 },
        hintText: 'Vessel 1 now shows color one on top; park it in the other empty glass.',
      },
      {
        text: 'Reunite what you parked: pour color two onto its match.',
        setup: L4_SETUP,
        require: { kind: 'pour-color', color: 1 },
        hintText: 'One of your parked vessels already holds color two — pour onto it.',
      },
    ],
  },
  {
    id: 'lesson-undo-restart', title: 'Second Thoughts',
    steps: [
      {
        text: 'Make any pour — this one you will take back. Pour vessel 1 into the empty glass.',
        setup: L5_SETUP,
        require: { kind: 'pour', from: 0, to: 2 },
        hintText: 'Lift vessel 1 and pour into vessel 3.',
      },
      {
        text: 'Undo is always free. Take that pour back now.',
        setup: L5_SETUP,
        require: { kind: 'undo' },
        hintText: 'Use undo (U key, or the undo control) to restore the previous shelf.',
      },
      {
        text: 'And when the whole arrangement displeases you, restart returns the shelf to its opening state. Restart now.',
        setup: L5_SETUP,
        require: { kind: 'restart' },
        hintText: 'Use restart (R key, or the restart control).',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Journey — 40 authored stages, mastery every 5th, graduated 3 -> 10 colors.
// parMoves is filled lazily by parFor()/validateContent() (never at import).
// ---------------------------------------------------------------------------

const JOURNEY_NAME_A = ['Emberwine', 'Verdigris', 'Mistveil', 'Sungilt', 'Azurite', 'Umbrail', 'Tidal', 'Cinnabar'];
const JOURNEY_NAME_B = ['Prelude', 'Draught', 'Crucible', 'Alembic', 'Tincture'];

function journeyStage(i) {
  const idx = i - 1;
  const id = `j${String(i).padStart(2, '0')}`;
  const theme = THEMES[idx % THEMES.length].id;
  const colorCount = 3 + Math.round((idx * 7) / 39); // 3 -> 10 across 40 stages
  const mastery = i % 5 === 0;
  // Late mastery stages occasionally tighten to a single empty vessel. Kept at
  // 9 colors: 10 colors / 1 empty exceeds the solver budget during generation.
  const emptyVessels = mastery && colorCount === 9 ? 1 : 2;
  const mechanics = ['pour'];
  if (colorCount >= 5) mechanics.push('planning');
  if (colorCount >= 8) mechanics.push('pressure');
  const def = {
    id,
    name: `${JOURNEY_NAME_A[idx % JOURNEY_NAME_A.length]} ${JOURNEY_NAME_B[Math.floor(idx / JOURNEY_NAME_A.length)]}`,
    kind: 'journey',
    colorCount,
    capacity: 4,
    emptyVessels,
    seed: `journey-${id}-${theme}`,
    parMoves: null,
    mastery,
    theme,
    mechanics,
    constraints: {},
    contentVersion: CONTENT_VERSION,
  };
  if (i === 1) def.tutorialFlag = 'first-journey';
  return def;
}

export const JOURNEY = Array.from({ length: 40 }, (_, i) => journeyStage(i + 1));

// ---------------------------------------------------------------------------
// Challenges — constrained variants. Move/time limits are set generously
// above par; validateContent proves the underlying board is solvable.
// ---------------------------------------------------------------------------

function challenge(id, name, desc, colorCount, emptyVessels, constraints) {
  return {
    id, name, desc, kind: 'challenge',
    colorCount, capacity: 4, emptyVessels,
    seed: `challenge-${id}-v1`,
    constraints, parMoves: null,
    theme: THEMES[colorCount % THEMES.length].id,
    contentVersion: CONTENT_VERSION,
  };
}

export const CHALLENGES = [
  challenge('c-measured', 'The Measured Hand', 'Six tinctures, forty pours. Count every motion.', 6, 2, { moveLimit: 40 }),
  challenge('c-heartbeats', 'Ninety Heartbeats', 'Solve six tinctures before the sand runs out: 90 seconds.', 6, 2, { timeLimitMs: 90000 }),
  challenge('c-lone-crucible', 'The Lone Crucible', 'Seven tinctures and only one empty vessel to think with.', 7, 1, {}),
  challenge('c-no-retreat', 'No Backward Step', 'Seven tinctures. Undo is sealed; commit to every pour.', 7, 2, { noUndo: true }),
  challenge('c-grand-decant', 'The Grand Decant', 'All ten tinctures against a five-minute glass.', 10, 2, { timeLimitMs: 300000 }),
  challenge('c-twin-fetters', 'Twin Fetters', 'Eight tinctures, sixty pours, two minutes. Both bind at once.', 8, 2, { moveLimit: 60, timeLimitMs: 120000 }),
];

// ---------------------------------------------------------------------------
// Level construction helpers
// ---------------------------------------------------------------------------

function isoDateOf(date) {
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) throw new Error('dailyLevel: invalid Date');
    return date.toISOString().slice(0, 10); // UTC calendar day
  }
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
      throw new Error(`dailyLevel: not a real calendar date: ${date}`);
    }
    return date;
  }
  throw new Error("dailyLevel: expected a Date or 'YYYY-MM-DD' string");
}

function dayOfYear(iso) {
  const y = Number(iso.slice(0, 4));
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}

/** Deterministic daily level. Same UTC day => same seed, ruleset, and theme. */
export function dailyLevel(date) {
  const iso = isoDateOf(date);
  const doy = dayOfYear(iso);
  const theme = THEMES[doy % THEMES.length].id;
  return {
    id: `daily-${iso}`,
    name: `Daily Draught ${iso}`,
    kind: 'daily',
    seed: `daily-${iso}`,
    colorCount: 5 + (doy % 4), // cycles 5..8 by day-of-year
    capacity: 4,
    emptyVessels: 2,
    constraints: {},
    parMoves: null,
    theme,
    contentVersion: CONTENT_VERSION,
  };
}

/** Practice level for a difficulty id; caller owns the seed. */
export function practiceLevel(difficultyId, seed = 'practice') {
  const d = DIFFICULTIES.find((x) => x.id === difficultyId);
  if (!d) throw new Error(`practiceLevel: unknown difficulty '${difficultyId}'`);
  return {
    id: `practice-${difficultyId}-${seed}`,
    name: `${d.label} Practice`,
    kind: 'practice',
    seed: String(seed),
    colorCount: d.colorCount,
    capacity: 4,
    emptyVessels: d.emptyVessels,
    constraints: {},
    parMoves: null,
    theme: THEMES[0].id,
    contentVersion: CONTENT_VERSION,
  };
}

/** Thin wrapper over rules.createGame; explicit vessels are honored. */
export function buildLevelState(levelDef) {
  return rules.createGame({
    seed: levelDef.seed,
    colorCount: levelDef.colorCount,
    capacity: levelDef.capacity ?? 4,
    emptyVessels: levelDef.emptyVessels ?? 2,
    constraints: levelDef.constraints || {},
    vessels: levelDef.vessels || null,
  });
}

/** Look up a level by id across journey, challenges, and lessons. Daily ids
 *  are handled by the caller via dailyLevel(date). */
export function getLevelById(id) {
  return JOURNEY.find((l) => l.id === id)
    || CHALLENGES.find((l) => l.id === id)
    || LESSONS.find((l) => l.id === id)
    || null;
}

// ---------------------------------------------------------------------------
// Par computation + content validation (lazy; import stays fast)
// ---------------------------------------------------------------------------

const _parCache = new Map();

function parKey(levelDef) {
  return `${levelDef.id}|${levelDef.seed}`;
}

function parFromDepth(depth) {
  return depth + Math.max(1, Math.round(depth * 0.25));
}

/** Solve the level and return par moves (solver depth + 25% slack). Cached. */
export function parFor(levelDef, { maxNodes = 120000 } = {}) {
  if (Number.isInteger(levelDef.parMoves)) return levelDef.parMoves;
  const key = parKey(levelDef);
  if (_parCache.has(key)) return _parCache.get(key);
  const state = buildLevelState(levelDef);
  const sol = rules.solve(state, { maxNodes });
  if (!sol.solvable || sol.depth == null) return null;
  const par = parFromDepth(sol.depth);
  _parCache.set(key, par);
  levelDef.parMoves = par;
  return par;
}

/**
 * Offline content proof: builds and solves every JOURNEY and CHALLENGES entry
 * plus 7 consecutive dailies from a fixed reference date (2026-01-15).
 * Verifies solvability, non-triviality (depth >= 3), and computes pars.
 */
export function validateContent({ maxNodes = 120000 } = {}) {
  const problems = [];
  const parUpdates = [];
  let checked = 0;

  const defs = [...JOURNEY, ...CHALLENGES];
  const refMs = Date.UTC(2026, 0, 15);
  for (let d = 0; d < 7; d++) defs.push(dailyLevel(new Date(refMs + d * 86400000)));

  for (const def of defs) {
    checked++;
    let state;
    try {
      state = buildLevelState(def);
    } catch (e) {
      problems.push(`${def.id}: build failed: ${e.message}`);
      continue;
    }
    if (rules.isSolved(state)) {
      problems.push(`${def.id}: initial board is already solved`);
      continue;
    }
    const sol = rules.solve(state, { maxNodes });
    if (!sol.solvable || sol.depth == null) {
      problems.push(`${def.id}: not solvable within ${maxNodes} nodes`);
      continue;
    }
    if (sol.depth < 3) {
      problems.push(`${def.id}: trivially shallow (solution depth ${sol.depth})`);
      continue;
    }
    const par = parFromDepth(sol.depth);
    def.parMoves = par;
    _parCache.set(parKey(def), par);
    parUpdates.push({ id: def.id, parMoves: par });
  }

  return { ok: problems.length === 0, problems, checked, parUpdates };
}
