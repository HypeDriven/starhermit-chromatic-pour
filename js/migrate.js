// migrate.js — the engine build's save document and game settings, and what
// carries over from the browser build (pure; Node-safe, so the tests run it):
// - the save (starhermit:storage `saves`): { v: 1, progression, bests } —
//   the storage.js progression record (journey stars and records, dailies,
//   achievements, mastery roll, sessions, streak) and the local best per
//   board, on the device and in the player's cloud slot; two devices' copies
//   merge record by record (storage.js mergeProgression / mergeBests);
// - the browser build's cloud save (the JS SDK's slot, shown to the engine
//   as a foreign save): the checksummed { settings, progression } document
//   storage.js exportSaveDoc wrote; its progression merges into the save,
//   its game options carry over;
// - the game's own settings (starhermit:storage `settings`, game.<key>,
//   kept with the account): palette, theme, labels on liquids, hints,
//   left-handed tray, hold to confirm, wide camera, lessons done, last mode.
//   Volumes, graphics, reduced motion, larger text, high contrast, key
//   bindings and the language are the runtime's Options now.
import { normalizeProgression, mergeProgression, mergeBests, verifyDoc, checksumDoc } from './storage.js';
import { COLOR_SETS, THEMES } from './content.js';

const obj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- the save

/** A save document with every part present and sane. */
export function normalize(d) {
  const src = obj(d) ? d : {};
  const bests = {};
  if (obj(src.bests)) {
    for (const [k, v] of Object.entries(src.bests)) {
      if (obj(v) && typeof v.score === 'number' && Number.isFinite(v.score)) bests[k] = v;
    }
  }
  return { v: 1, progression: normalizeProgression(src.progression), bests };
}

/** The document in an engine save's data, or null when it holds none. */
export function docFromSave(data) {
  if (!obj(data) || data.v !== 1) return null;
  return normalize(data);
}

/** Two documents merged (either may be null), keeping the better of every record. */
export function mergeDocs(a, b) {
  if (!a && !b) return normalize({});
  if (!a) return normalize(b);
  if (!b) return normalize(a);
  const x = normalize(a), y = normalize(b);
  return normalize({ progression: mergeProgression(x.progression, y.progression), bests: mergeBests(x.bests, y.bests) });
}

/**
 * The browser build's cloud save (its save.json text): the progression as a
 * document, and the game settings it carried. A document whose checksum
 * fails is still read when it has the right shape (normalize sanitizes it);
 * anything else gives nulls.
 */
export function fromBrowserSave(text) {
  if (typeof text !== 'string') return { doc: null, settings: null };
  let d;
  try { d = JSON.parse(text); } catch { return { doc: null, settings: null }; }
  const data = verifyDoc(d) ?? (obj(d) && obj(d.data) ? d.data : null);
  if (!obj(data)) return { doc: null, settings: null };
  return {
    doc: obj(data.progression) ? normalize({ progression: data.progression }) : null,
    settings: obj(data.settings) ? gameSettingsFrom(data.settings) : null,
  };
}

// ---------------------------------------------------------------- settings

const bool = (v) => typeof v === 'boolean';
const MODE_KINDS = ['journey', 'daily', 'practice', 'challenge', 'score-chase'];
/** The game's own settings (game.<key> in the runtime's settings) with their checks. */
export const GAME_SETTINGS = {
  palette: (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(COLOR_SETS, v),
  theme: (v) => THEMES.some((t) => t.id === v),
  labelsOnLiquids: bool,
  hintsEnabled: bool,
  leftHanded: bool,
  holdToConfirm: bool,
  cameraWide: bool,
  tutorialDone: bool,
  lastMode: (v) => v === null || MODE_KINDS.includes(v),
};
export const GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
export const DEFAULT_GAME_SETTINGS = Object.freeze({
  palette: 'standard', theme: 'ember', labelsOnLiquids: true, hintsEnabled: true, leftHanded: false,
  holdToConfirm: false, cameraWide: false, tutorialDone: false, lastMode: null,
});
/** A value for a game setting when it passes its check, else undefined. */
export function checkSetting(key, value) {
  const check = GAME_SETTINGS[key];
  return check && check(value) ? value : undefined;
}
/** The game settings found in a browser-build settings object. */
export function gameSettingsFrom(s) {
  const out = {};
  if (!obj(s)) return out;
  for (const k of GAME_SETTING_KEYS) {
    const v = checkSetting(k, s[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
/**
 * The account settings the browser build mirrored (js/main.js
 * SYNCED_SETTINGS through the SDK's patchSettings), read as legacy keys:
 * the game's own carry over, the rest (volumes, graphics, accessibility) are
 * the runtime's now; all are removed once read.
 */
export const BROWSER_SETTING_KEYS = ['music', 'effects', 'ambience', 'voice', 'palette', 'theme', 'graphics', 'reducedMotion',
  'largerText', 'highContrast', 'leftHanded', 'holdToConfirm', 'hintsEnabled', 'labelsOnLiquids', 'cameraWide'];

// ---------------------------------------------------------------- export / import

/** The exported save file's text (the browser build's format: a checksummed { exportedAt, settings, progression }). */
export function exportText(settings, progression, exportedAt) {
  return JSON.stringify(checksumDoc({ exportedAt, settings: gameSettingsFrom(settings), progression: normalizeProgression(progression) }), null, 2);
}
/** An imported save file: { settings, progression } (progression null when absent), or null when it is not a valid save. */
export function importText(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  const data = verifyDoc(d);
  if (!obj(data)) return null;
  return {
    settings: gameSettingsFrom(data.settings),
    progression: obj(data.progression) ? normalizeProgression(data.progression) : null,
  };
}
