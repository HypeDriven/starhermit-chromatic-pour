// Live probe for the Chromatic Pour authoritative API (dev verification only).
// Starts server.js on an ephemeral port, plays real rounds through GameSession
// + the solver, submits entries shaped exactly like js/ui.js endRound(), and
// checks acceptance/rejection paths.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fsTemp = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const dataDir = await fsTemp.mkdtemp(path.join(tmpdir(), 'cp-api-'));
const rules = await import(path.join(ROOT, 'js/rules.js'));
const { GameSession } = await import(path.join(ROOT, 'js/session.js'));
const content = await import(path.join(ROOT, 'js/content.js'));

const PORT = 0;
let BASE;

const server = spawn('node', [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CP_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { server.kill(); reject(new Error('server start timeout')); }, 8000);
  server.stdout.on('data', (d) => { const m = String(d).match(/localhost:(\d+)/); if (m) { BASE = `http://127.0.0.1:${m[1]}`; clearTimeout(timer); resolve(); } });
  server.on('exit', () => reject(new Error('server exited early')));
});

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Play a level to completion exactly like the client would, mock clock.
function playRound(levelDef) {
  let nowMs = 100000;
  const session = new GameSession(levelDef, { sessionId: `probe-${levelDef.id}`, now: () => nowMs });
  session.start();
  for (let i = 0; i < 200 && session.state.status === 'active'; i++) {
    nowMs += 1500;
    const sol = rules.solve(session.state, { maxNodes: 200000 });
    if (!sol.solvable || !sol.moves.length) break;
    const [from, to] = sol.moves[0];
    const r = session.pour(from, to);
    if (!r.ok) throw new Error(`pour rejected: ${r.reason}`);
  }
  if (session.state.status !== 'complete') throw new Error(`round did not complete: ${session.state.status}`);
  return session;
}

// Exact entry shape produced by js/ui.js endRound().
function buildEntry(levelDef, session) {
  const result = session.result();
  return {
    levelId: levelDef.id,
    seed: levelDef.seed,
    contentVersion: levelDef.contentVersion ?? 1,
    sessionId: result.sessionId,
    result: {
      score: result.score.total,
      moves: result.moves,
      invalidActions: result.invalidActions,
      elapsedMs: result.elapsedMs,
      assists: result.assists,
      sessionId: result.sessionId,
    },
    replay: session.replayEnvelope(),
  };
}

async function submit(levelDef) {
  // Mirror startLevel(): par is resolved (and cached onto the level def)
  // before the round, so the client's score uses the same par as the server.
  if (!Number.isInteger(levelDef.parMoves)) content.parFor(levelDef, { maxNodes: 200000 });
  const session = playRound(levelDef);
  const entry = buildEntry(levelDef, session);
  const r = await post('/api/v1/scores', { board: levelDef.id, entry });
  return { r, session, entry };
}

try {
  // 1. Today's daily is accepted and ranked.
  const today = new Date().toISOString().slice(0, 10);
  const daily = content.dailyLevel(today);
  const d = await submit(daily);
  check('daily submit accepted', d.r.status === 200 && d.r.json?.accepted === true,
    `status=${d.r.status} ${JSON.stringify(d.r.json)}`);
  check('daily submit ranked', typeof d.r.json?.rank === 'number' && d.r.json.rank >= 1);

  // 2. Yesterday's daily is rejected as not current.
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const stale = await submit(content.dailyLevel(y));
  check('past daily rejected (board-not-current)',
    stale.r.status === 422 && stale.r.json?.error === 'board-not-current', `status=${stale.r.status}`);

  // 3. Authored challenge board is accepted.
  const ch = content.getLevelById('c-measured');
  const c = await submit(ch);
  check('challenge submit accepted', c.r.status === 200 && c.r.json?.accepted === true,
    `status=${c.r.status} ${JSON.stringify(c.r.json)}`);

  // 4. Score-chase evergreen board is accepted.
  const chase = content.practiceLevel('master', 'chase-evergreen');
  const sc = await submit(chase);
  check('score-chase submit accepted', sc.r.status === 200 && sc.r.json?.accepted === true,
    `status=${sc.r.status} ${JSON.stringify(sc.r.json)}`);

  // 5. Arbitrary practice seed is rejected.
  const bogus = content.practiceLevel('master', 'brew-selfmade');
  const b = await submit(bogus);
  check('self-invented practice board rejected (unsupported-level)',
    b.r.status === 422 && b.r.json?.error === 'unsupported-level', `status=${b.r.status}`);

  // 6. Tampered score is rejected.
  const t = await submit(content.dailyLevel(today));
  const forged = JSON.parse(JSON.stringify(t.entry));
  forged.result.score += 500;
  const f = await post('/api/v1/scores', { board: forged.levelId, entry: forged });
  check('forged score rejected (score-mismatch)', f.status === 422 && f.json?.error === 'score-mismatch',
    `status=${f.status} ${JSON.stringify(f.json)}`);

  // 7. Leaderboard reflects the accepted daily entry.
  const lb = await fetch(`${BASE}/api/v1/leaderboard?board=${encodeURIComponent(daily.id)}`).then((r) => r.json());
  check('leaderboard returns daily entries', Array.isArray(lb.entries) && lb.entries.length >= 1,
    `${lb.entries?.length} entries`);
  check('leaderboard entry shape', lb.entries?.[0] && typeof lb.entries[0].score === 'number' && lb.entries[0].rank === 1);

  // 8. Telemetry counts key on `type` (the client wire field).
  await post('/api/v1/telemetry', { events: [{ type: 'start', data: { kind: 'daily' }, t: Date.now() }, { type: 'round-end', data: {}, t: Date.now() }] });
  await new Promise((r) => setTimeout(r, 600)); // debounced flush
  const counts = JSON.parse(await import('node:fs/promises').then((fs) =>
    fs.readFile(path.join(dataDir, 'telemetry.json'), 'utf8'))).counts || {};
  check('telemetry counted by type', (counts.start || 0) >= 1 && (counts['round-end'] || 0) >= 1,
    JSON.stringify(counts));

  // 9. Achievement endpoint is idempotent.
  const a1 = await post('/api/v1/achievements', { key: 'first-pour-complete' });
  const a2 = await post('/api/v1/achievements', { key: 'first-pour-complete' });
  check('achievement unlock + idempotent re-unlock',
    a1.status === 200 && a2.status === 200 && a2.json?.already === true);

  // 10. Malformed percent-encoding is a 400, not a 500, and the server stays up.
  const bad = await fetch(BASE + '/%');
  check('malformed URI -> 400', bad.status === 400, `status=${bad.status}`);
  const alive = await fetch(`${BASE}/api/v1/time`);
  check('server alive after malformed URI', alive.status === 200);
} catch (err) {
  console.error('probe error:', err);
  failures++;
} finally {
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await stopped;
  await fsTemp.rm(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\nPROBE FAIL (${failures})` : '\nPROBE PASS');
process.exit(failures ? 1 : 0);
