// Localization coverage: every English key the engine client (native/*.ts, its
// tr()/N() literals) and the content use is translated in every locale (en-GB →
// en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders survive, and the
// language switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadTables, codeKeys, audit } from './i18n-common.mjs';
import { THEMES, DIFFICULTIES, LESSONS, CHALLENGES } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/storage.js';
import { INVALID_MESSAGES } from '../js/rules.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) codeKeys(read(`native/${f}`), [], ['tr', 'N']).forEach((k) => keys.add(k));
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

test('setLocale switches the language live, with the regional fallbacks', () => {
  // js/strings.js and js/i18n.js as classic scripts, as native/i18n.ts loads them.
  const ctx = vm.createContext({});
  vm.runInContext(read('js/strings.js'), ctx);
  vm.runInContext(read('js/i18n.js'), ctx);
  const I18N = ctx.CPI18N;
  assert.equal(I18N.lang, 'en-US');
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  assert.equal(I18N.setLocale('fr-CA'), 'fr-CA');
  assert.equal(I18N.T('Score chase'), 'Chasse au pointage');
  assert.equal(I18N.T('Open Options'), 'Ouvrir les Options', 'fr-CA falls back to fr-FR');
  I18N.setLocale('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
  assert.equal(I18N.T('{n} moves', { n: 4 }), '4 moves');
  assert.equal(I18N.setLocale('xx-YY'), 'en-US', 'an unknown locale is en-US');
});
