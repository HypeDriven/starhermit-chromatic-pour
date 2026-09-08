/**
 * Chromatic Pour — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   load → title → settings open/close → journey setup → stage 1 →
 *   countdown → play (real vessel clicks, keyboard hint/undo/pause) →
 *   solve the board to completion → results screen, on both a desktop
 *   (1280x800) and a mobile (390x844, touch) viewport.
 *
 * The repo's server.js is the StarHermit authoritative distribution server
 * (fixed PORT, writes data/ JSON stores) — not a plain dev server — so this
 * test embeds its own minimal static server on an ephemeral port. The game
 * runs fully standalone without a launch token (platform.js degrades to
 * local-only), so no backend is needed.
 *
 * Move planning reads the vessel layer colors from the visible DOM board and
 * solves with the game's own pure rules engine (js/rules.js); every action
 * itself goes through real UI clicks/key presses.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import * as rules from '../js/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/chromatic-pour-e2e-${stage}-${vp}.png`;

// Benign GPU/swiftshader console noise (mirrors tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

// Hosted-mode fixture: the StarHermit launcher opens the game as
// index.html#game_token=<jwt> and the platform serves /api same-origin. This
// mock covers only what the hosted pass needs — clock sync and the profile
// read a game-scoped token is allowed to make — and records the bearer header
// so the test can prove the token was sent.
const HOST_USER_ID = 'a1b2c3d4-0000-4000-8000-feedfacecafe';
const HOST_NICKNAME = 'Starfox Al';
const hostCalls = [];
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}
const HOST_TOKEN = fakeJwt({ sub: HOST_USER_ID, game_scope: 'chromatic-pour', unique_name: 'albert_raw' });

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function mockApi(req, res, pathname) {
  hostCalls.push({ path: pathname, auth: req.headers.authorization || null });
  if (req.method === 'GET' && pathname === '/api/v1/time') return sendJson(res, 200, { epochMs: Date.now() });
  if (req.method === 'GET' && pathname === `/api/v1/users/${HOST_USER_ID}/profile`) {
    if (req.headers.authorization !== `Bearer ${HOST_TOKEN}`) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { id: HOST_USER_ID, username: 'albert_raw', nickname: HOST_NICKNAME });
  }
  return sendJson(res, 404, { error: 'not-found' });
}

function startServer() {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.startsWith('/api/')) return mockApi(req, res, rel);
    if (rel === '/') rel = '/index.html';
    const filePath = path.resolve(ROOT, '.' + rel);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The app's own state machine logs every transition on window.__cpTransitions;
// the last allowed one is the current screen state. Used for sync only.
async function appState(page) {
  const t = await page.evaluate(() => {
    const list = window.__cpTransitions || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].allowed) return list[i].to;
    return 'boot';
  });
  return t;
}

async function waitForState(page, wanted, timeout = 12000) {
  const names = Array.isArray(wanted) ? wanted : [wanted];
  await page.waitForFunction((ns) => {
    const list = window.__cpTransitions || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].allowed) return ns.includes(list[i].to);
    }
    return false;
  }, names, { timeout });
}

// Read the board from the visible DOM: each .vessel button's tube holds one
// span per capacity slot; filled slots carry data-color (bottom-first order).
async function readBoard(page) {
  return page.evaluate(() => {
    const tubes = [...document.querySelectorAll('#screen-play .cp-board .vessel .vessel-tube')];
    if (!tubes.length) return null;
    const capacity = tubes[0].children.length;
    const vessels = tubes.map((tube) =>
      [...tube.children]
        .filter((slot) => slot.dataset.color !== undefined)
        .map((slot) => Number(slot.dataset.color)));
    return { vessels, capacity };
  });
}

async function solveFromDom(page) {
  const board = await readBoard(page);
  if (!board) throw new Error('board not present in DOM');
  const colorCount = Math.max(...board.vessels.flat()) + 1;
  const state = {
    version: rules.RULES_VERSION, seed: 'e2e', colorCount,
    capacity: board.capacity, vessels: board.vessels,
    turn: 0, moves: 0, invalidActions: 0, elapsedMs: 0,
    status: 'active', terminalReason: null, constraints: {}, appliedCommandIds: [],
  };
  if (rules.isSolved(state)) return { solved: true, move: null };
  const sol = rules.solve(state, { maxNodes: 200000 });
  if (!sol.solvable || !sol.moves.length) throw new Error('solver found no solution from current board');
  return { solved: false, move: sol.moves[0], depth: sol.depth };
}

async function clickVessel(page, index) {
  await page.locator(`#screen-play .cp-board .vessel[data-index="${index}"]`).click({ timeout: 5000 });
}

// Wait until the pour animation settles (input unlocked ⇔ skip button hidden).
async function waitPourSettled(page) {
  await page.waitForFunction(() => {
    const skip = document.querySelector('#screen-play .cp-skip');
    return !skip || skip.hidden;
  }, null, { timeout: 5000 });
}

async function movesText(page) {
  return (await page.locator('#screen-play .cp-moves').first().textContent())?.trim();
}

const step = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

function checkErrors(label, errors) {
  const bad = errors.filter((e) => !browserNoise.test(e));
  if (bad.length) {
    throw new Error(`page errors during ${label}:\n${bad.join('\n')}`);
  }
}

async function runPass(browser, vpName, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  try {
    await step(`[${vpName}] load + title visible`, async () => {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
      await waitForState(page, ['title', 'profile-ready']);
      if (!(await page.locator('.cp-wordmark').isVisible())) throw new Error('wordmark not visible');
      await page.screenshot({ path: SHOT('title', vpName) });
    });

    await step(`[${vpName}] settings open/close from title`, async () => {
      await page.locator('#screen-title .cp-title-nav button', { hasText: 'Settings' }).click();
      await page.waitForSelector('#screen-settings:not([hidden])');
      if (!(await page.locator('#screen-settings h1', { hasText: 'Settings' }).isVisible())) {
        throw new Error('settings heading missing');
      }
      await page.screenshot({ path: SHOT('settings', vpName) });
      await page.locator('#screen-settings button', { hasText: 'Back' }).last().click();
      await page.waitForSelector('#screen-title:not([hidden])');
    });

    await step(`[${vpName}] journey setup: 40 stages, stage 1 unlocked`, async () => {
      await page.locator('#screen-title .card-journey').click();
      await page.waitForSelector('#screen-setup:not([hidden])');
      const cells = await page.locator('#screen-setup .stage-cell').count();
      if (cells !== 40) throw new Error(`expected 40 stages, got ${cells}`);
      const unlocked = await page.locator('#screen-setup .stage-cell:not(.locked)').count();
      if (unlocked !== 1) throw new Error(`expected 1 unlocked stage, got ${unlocked}`);
      await page.screenshot({ path: SHOT('setup', vpName) });
    });

    await step(`[${vpName}] stage 1 → countdown → active`, async () => {
      await page.locator('#screen-setup .stage-cell').first().click();
      await waitForState(page, 'countdown');
      await page.screenshot({ path: SHOT('countdown', vpName) });
      await waitForState(page, 'active');
      await page.waitForSelector('#screen-play:not([hidden])');
      const vessels = await page.locator('#screen-play .cp-board .vessel').count();
      if (vessels < 3) throw new Error(`expected vessels on the shelf, got ${vessels}`);
      await page.screenshot({ path: SHOT('play', vpName) });
    });

    await step(`[${vpName}] pause via keyboard, resume via button`, async () => {
      await page.keyboard.press('p');
      await waitForState(page, 'paused');
      await page.waitForSelector('.cp-overlay:has(#pause-title)', { timeout: 5000 });
      await page.screenshot({ path: SHOT('pause', vpName) });
      await page.locator('.cp-overlay button', { hasText: 'Resume' }).click();
      await waitForState(page, 'active');
      if (await page.locator('.cp-overlay').count()) throw new Error('pause overlay still present after resume');
    });

    await step(`[${vpName}] hint announces a suggested pour`, async () => {
      await page.keyboard.press('h');
      await page.waitForFunction(() =>
        /The ledger suggests: pour/.test(
          [...document.querySelectorAll('.sr-only[role="status"]')].map((n) => n.textContent).join(' ')),
      null, { timeout: 5000 });
    });

    await step(`[${vpName}] first pour via vessel clicks, then undo`, async () => {
      const { move } = await solveFromDom(page);
      await clickVessel(page, move[0]);
      await clickVessel(page, move[1]);
      await waitPourSettled(page);
      if ((await movesText(page)) !== '1 move') throw new Error(`expected "1 move", got "${await movesText(page)}"`);
      await page.keyboard.press('u');
      await page.waitForFunction(() =>
        document.querySelector('#screen-play .cp-moves')?.textContent.trim() === '0 moves',
      null, { timeout: 5000 });
      await page.screenshot({ path: SHOT('play-undo', vpName) });
    });

    await step(`[${vpName}] solve the board through vessel clicks → results`, async () => {
      for (let i = 0; i < 60; i++) {
        if (await page.locator('#screen-results:not([hidden])').count()) break;
        if ((await appState(page)) !== 'active') break;
        const { solved, move } = await solveFromDom(page);
        if (solved) break;
        await clickVessel(page, move[0]);
        await clickVessel(page, move[1]);
        await waitPourSettled(page);
      }
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 15000 });
      await waitForState(page, 'results');
    });

    await step(`[${vpName}] results screen shows score breakdown`, async () => {
      const headline = (await page.locator('#screen-results h1').textContent())?.trim();
      if (!headline) throw new Error('no results headline');
      const rows = await page.locator('#screen-results .cp-score-table tbody tr').count();
      if (rows < 4) throw new Error(`expected score breakdown rows, got ${rows}`);
      for (const label of ['Replay', 'Change mode', 'View progress']) {
        if (!(await page.locator('#screen-results button', { hasText: label }).first().isVisible())) {
          throw new Error(`results action "${label}" missing`);
        }
      }
      console.log(`  [${vpName}] headline: ${headline}`);
      await page.screenshot({ path: SHOT('results', vpName) });
    });

    await step(`[${vpName}] progression persisted (journey star recorded)`, async () => {
      const prog = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('chromatic-pour:progression') || 'null'));
      if (!prog || !prog.journey || !Object.keys(prog.journey).length) {
        throw new Error('journey progress not persisted');
      }
      if (!prog.sessionsPlayed) throw new Error('sessionsPlayed not persisted');
      console.log(`  [${vpName}] journey:`, JSON.stringify(prog.journey));
    });

    checkErrors(vpName, errors);
  } finally {
    await context.close();
  }
}

// Launched from StarHermit: the top chip must show the profile nickname, not
// "Guest — sign in" and not the raw account username.
async function runHostedPass(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  hostCalls.length = 0;
  try {
    await step('[hosted] launch with #game_token shows nickname', async () => {
      await page.goto(`${baseUrl}/index.html#game_token=${HOST_TOKEN}`, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
      await waitForState(page, ['title', 'profile-ready']);
      const chip = page.locator('.cp-profilechip');
      await page.waitForFunction(
        (nick) => document.querySelector('.cp-profilechip')?.textContent.trim() === nick,
        HOST_NICKNAME, { timeout: 8000 },
      );
      const text = (await chip.textContent()).trim();
      if (text !== HOST_NICKNAME) throw new Error(`profile chip reads "${text}", expected "${HOST_NICKNAME}"`);
      if (/guest|sign in|albert_raw/i.test(text)) throw new Error(`profile chip leaks guest/username text: "${text}"`);
      const label = await chip.getAttribute('aria-label');
      if (!label || !label.includes(HOST_NICKNAME)) throw new Error(`chip aria-label missing nickname: ${label}`);
      const profileCall = hostCalls.find((c) => c.path === `/api/v1/users/${HOST_USER_ID}/profile`);
      if (!profileCall) throw new Error('game never requested the profile endpoint');
      if (profileCall.auth !== `Bearer ${HOST_TOKEN}`) throw new Error('profile request lacked the launch token bearer header');
      await page.screenshot({ path: SHOT('hosted-title', 'desktop') });
    });
    checkErrors('hosted pass', errors);
  } finally {
    await context.close();
  }
}

const server = await startServer();
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`serving ${ROOT} on ${baseUrl}`);

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

try {
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runPass(browser, 'mobile', {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  await runHostedPass(browser);
  console.log('\nE2E PASS — full playthrough on desktop + mobile + hosted nickname, no page errors');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
