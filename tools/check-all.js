// tools/check-all.js — `npm run check` target.
// Syntax-checks every shipped/relevant module without executing it, so a
// module that fails to parse is caught in CI rather than at runtime.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsFiles = fs
  .readdirSync(path.join(ROOT, 'js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join('js', f));
const files = [
  'server.js',
  ...jsFiles,
  ...fs.readdirSync(path.join(ROOT, 'tests')).map((f) => path.join('tests', f)),
];

let checked = 0;
for (const rel of files) {
  // Only check source-ish files (skip binaries/images that happen to live there).
  if (!/\.(js|mjs|cjs)$/.test(rel)) continue;
  execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
  checked++;
}

if (checked === 0) {
  console.error('check-all: no modules found');
  process.exit(1);
}
console.log(`check-all: ${checked} modules clean`);
