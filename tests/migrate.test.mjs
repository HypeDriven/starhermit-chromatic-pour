// The engine save document and what carries over from the browser build
// (js/migrate.js): two devices' documents merge record by record, the browser
// build's checksummed cloud save becomes a document plus its game settings,
// and exported save files round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/migrate.js';
import { checksumDoc, normalizeProgression } from '../js/storage.js';

const prog = (journey) => ({ ...normalizeProgression({}), journey });

test('a save document is normalized, and junk gives an empty one', () => {
  assert.deepEqual(M.normalize(null), { v: 1, progression: normalizeProgression({}), bests: {} });
  assert.equal(M.docFromSave({ v: 2 }), null);
  assert.equal(M.docFromSave('x'), null);
  const d = M.normalize({ bests: { a: { score: 10 }, b: { score: 'x' }, c: null } });
  assert.deepEqual(Object.keys(d.bests), ['a']);
});

test('two devices merge keeping the better record of each stage', () => {
  const a = M.normalize({ progression: prog({ j01: { stars: 3, bestMoves: 12, bestMs: 9000 } }), bests: { daily: { score: 100 } } });
  const b = M.normalize({ progression: prog({ j01: { stars: 2, bestMoves: 10, bestMs: 15000 }, j02: { stars: 1, bestMoves: 20, bestMs: 30000 } }), bests: { daily: { score: 150 } } });
  const m = M.mergeDocs(a, b);
  assert.deepEqual(m.progression.journey.j01, { stars: 3, bestMoves: 10, bestMs: 9000 });
  assert.equal(m.progression.journey.j02.stars, 1);
  assert.equal(m.bests.daily.score, 150);
  assert.deepEqual(M.mergeDocs(null, null), M.normalize({}));
  assert.deepEqual(M.mergeDocs(a, null), a);
});

test('the browser build\'s cloud save carries its progression and game settings', () => {
  const settings = { palette: 'deuteranopia', theme: 'ember', music: 0.4, labelsOnLiquids: false, graphics: { preset: 'high' } };
  const text = JSON.stringify(checksumDoc({ settings, progression: prog({ j01: { stars: 2, bestMoves: 11, bestMs: 8000 } }) }));
  const { doc, settings: game } = M.fromBrowserSave(text);
  assert.equal(doc.progression.journey.j01.stars, 2);
  assert.deepEqual(game, { palette: 'deuteranopia', theme: 'ember', labelsOnLiquids: false }, 'only the game\'s own options carry over');
  // A tampered checksum is still read when the shape is right.
  const tampered = JSON.parse(text); tampered.checksum = 'bad';
  assert.equal(M.fromBrowserSave(JSON.stringify(tampered)).doc.progression.journey.j01.stars, 2);
  assert.deepEqual(M.fromBrowserSave('not json'), { doc: null, settings: null });
  assert.deepEqual(M.fromBrowserSave(null), { doc: null, settings: null });
});

test('game settings are checked, and exported files round-trip', () => {
  assert.equal(M.checkSetting('theme', 'nope'), undefined);
  assert.equal(M.checkSetting('hintsEnabled', false), false);
  assert.equal(M.checkSetting('unknown', 1), undefined);
  const p = prog({ j03: { stars: 1, bestMoves: 30, bestMs: 60000 } });
  const back = M.importText(M.exportText({ leftHanded: true, music: 1 }, p, '2026-10-27T00:00:00Z'));
  assert.deepEqual(back.settings, { leftHanded: true });
  assert.equal(back.progression.journey.j03.bestMoves, 30);
  assert.equal(M.importText('{"checksum":"x","data":{}}'), null, 'a file failing its checksum is refused');
});
