// Localization coverage: every English key the engine client (native/*.ts, its
// tr()/N() literals) and the content use is translated in every locale (en-GB →
// en-US, es-ES → es-419, fr-CA → fr-FR inherit), placeholders survive, and the
// language switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
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
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && !k.startsWith('starhermit.')).sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  assert.deepEqual(audit(JSON.parse(read('assets/strings.json')), usedKeys()), []);
});

test('session and rules messages shown to players are covered', () => {
  const session = read('js/session.js');
  for (const m of session.matchAll(/message: '([^']+)'/g)) assert.ok(usedKeys().includes(m[1]), m[1]);
  for (const m of read('js/rules.js').matchAll(/label: '([^']+)'/g)) assert.ok(usedKeys().includes(m[1]), m[1]);
});
