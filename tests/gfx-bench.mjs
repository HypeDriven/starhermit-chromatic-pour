// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// screen, starts Journey stage 1 and keeps pouring through the visible vessel buttons (solver-planned
// from the DOM board), replaying from the results screen, so pours, splashes, motes, candle flicker and
// the post chain all run.
import * as rules from '../js/rules.js';

export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 20000 });
  await page.locator('#screen-title .cp-title-nav button', { hasText: 'Settings' }).click();
  await page.waitForSelector('#screen-settings:not([hidden]) #gfx-section');
  await page.locator('#gfx-preset').selectOption(preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings button', { hasText: 'Back' }).last().click();
  await page.waitForSelector('#screen-title:not([hidden])');
}

async function nextMove(page) {
  const board = await page.evaluate(() => {
    const tubes = [...document.querySelectorAll('#screen-play:not([hidden]) .cp-board .vessel .vessel-tube')];
    if (!tubes.length) return null;
    return { capacity: tubes[0].children.length,
      vessels: tubes.map((t) => [...t.children].filter((s) => s.dataset.color !== undefined).map((s) => Number(s.dataset.color))) };
  });
  if (!board) return null;
  const state = { version: rules.RULES_VERSION, seed: 'bench', colorCount: Math.max(...board.vessels.flat()) + 1,
    capacity: board.capacity, vessels: board.vessels, turn: 0, moves: 0, invalidActions: 0, elapsedMs: 0,
    status: 'active', terminalReason: null, constraints: {}, appliedCommandIds: [] };
  if (rules.isSolved(state)) return null;
  const sol = rules.solve(state, { maxNodes: 100000 });
  return sol.solvable && sol.moves.length ? sol.moves[0] : null;
}

async function step(page) {
  if (await page.locator('#screen-results:not([hidden])').count()) {
    await page.locator('#screen-results button', { hasText: 'Replay' }).first().click({ timeout: 1000 });
    return;
  }
  const skip = await page.evaluate(() => { const s = document.querySelector('#screen-play .cp-skip'); return !!s && !s.hidden; });
  if (skip) return; // a pour is still animating
  const move = await nextMove(page);
  if (!move) return;
  const vessel = (i) => page.locator(`#screen-play .cp-board .vessel[data-index="${i}"]`);
  await vessel(move[0]).click({ timeout: 1000 });
  await vessel(move[1]).click({ timeout: 1000 });
}

export async function start(page) {
  await page.locator('#screen-title .card-journey').click();
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.locator('#screen-setup .stage-cell').first().click();
  await page.waitForSelector('#screen-play:not([hidden]) .cp-board .vessel', { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); await page.waitForTimeout(150); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
    }
  })();
  await page.waitForTimeout(3500); // countdown
}
