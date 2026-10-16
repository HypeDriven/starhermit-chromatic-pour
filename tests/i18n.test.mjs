// Localization coverage: every English key the markup, code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, and the language follows sh-language.js and
// switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';
import { THEMES, DIFFICULTIES, LESSONS, CHALLENGES } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/storage.js';
import { INVALID_MESSAGES } from '../js/rules.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/ui.js', 'js/main.js', 'js/gfx.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  for (const t of THEMES) keys.add(t.name);
  for (const d of DIFFICULTIES) { keys.add(d.label); keys.add(d.desc); }
  for (const l of LESSONS) { keys.add(l.title); for (const s of l.steps) { if (s.text) keys.add(s.text); if (s.hintText) keys.add(s.hintText); } }
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.desc); }
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  Object.values(INVALID_MESSAGES).forEach((m) => keys.add(m));
  ['Select a vessel with liquid in it first.', 'Completion', 'Move efficiency', 'Time bonus', 'Invalid actions', 'Lesson'].forEach((k) => keys.add(k));
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CP_STRINGS'), usedKeys()), []);
});

test('session and rules messages shown to players are covered', () => {
  const session = read('js/session.js');
  for (const m of session.matchAll(/message: '([^']+)'/g)) assert.ok(usedKeys().includes(m[1]), m[1]);
  for (const m of read('js/rules.js').matchAll(/label: '([^']+)'/g)) assert.ok(usedKeys().includes(m[1]), m[1]);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CPI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
  assert.equal(I18N.T('{n} moves', { n: 4 }), '4 moves');
});
