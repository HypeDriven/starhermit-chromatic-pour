// Prints play-script lines that solve a level by clicking its vessels: the
// level is built as the game builds it (rules.createGame with the content's
// seed), solved with the rules' own solver, and each pour becomes two clicks
// on the vessels' accessible labels ("Vessel N:"), waiting for the pour to
// settle between moves.
//   node tools/gen-play.mjs <journey stage number | lesson/challenge id>
import * as rules from '../js/rules.js';
import { JOURNEY, CHALLENGES } from '../js/content.js';

const arg = process.argv[2] || '1';
const def = /^\d+$/.test(arg) ? JOURNEY[Number(arg) - 1] : CHALLENGES.find((c) => c.id === arg);
if (!def) { console.error(`no level ${arg}`); process.exit(1); }
const state = rules.createGame({
  seed: def.seed, colorCount: def.colorCount, capacity: def.capacity || 4,
  emptyVessels: def.emptyVessels ?? 2, constraints: def.constraints || {}, vessels: def.vessels || null,
});
const sol = rules.solve(state, { maxNodes: 400000 });
if (!sol.solvable) { console.error(`${def.id}: no solution found`); process.exit(1); }
console.log(`# ${def.id} (${def.name}): ${sol.moves.length} pours from the rules' solver`);
for (const m of sol.moves) {
  const [from, to] = Array.isArray(m) ? m : [m.from, m.to];
  console.log([`click Vessel ${from + 1}:`, 'frames 5', `click Vessel ${to + 1}:`, 'frames 45'].join('\n'));
}
