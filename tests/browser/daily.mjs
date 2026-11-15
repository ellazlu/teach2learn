// L2T Daily in the real UI: nav entry, today's challenge, countdown, username,
// a session on the shared challenge (no extraction call, token on live calls),
// server-scored banner, leaderboard, retry. Run via tests/browser/run.sh.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const manifest = ['application/json', JSON.stringify({ format: 'png', frames: [] })];
const files = {
  '/avatar/avatar.json': manifest,
  ...Object.fromEntries(['kindergarten', 'middle', 'high', 'college', 'expert'].map((l) => [`/avatar/${l}/avatar.json`, manifest])),
  '/': ['text/html', `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`],
  '/app.js': ['text/javascript', () => readFileSync(path.join(root, 'tests/browser/out/app.js'))],
  '/app.css': ['text/css', () => readFileSync(path.join(root, 'app/globals.css'))],
};
const server = createServer((req, res) => {
  const f = files[req.url];
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': f[0] }).end(typeof f[1] === 'function' ? f[1]() : f[1]);
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (s) => console.log(`✓ ${s}`);
const say = (t) => page.evaluate((x) => window.__teacherSays(x), t);
const shot = (name) => page.screenshot({ path: path.join(root, `tests/browser/out/${name}.png`), fullPage: true });

try {
  await page.goto(url);
  await page.click('.topnav button:has-text("L2T Daily")');
  await page.waitForSelector('.daily-challenge h2');
  const objectives = await page.$$eval('.objectives li', (n) => n.map((x) => x.textContent));
  assert.equal(objectives.length, 3);
  assert.match(await page.textContent('.daily-stats'), /Next challenge in\s*\d+h \d{2}m \d{2}s/);
  assert.match(await page.textContent('.daily-board'), /No scores yet today/);
  await shot('d0-daily');
  step(`today's challenge "${await page.textContent('.daily-challenge h2')}" with objectives, countdown and empty board`);

  assert.ok(await page.isDisabled('.daily-start button'), 'needs a username');
  await page.fill('.daily-start input', 'Ada');
  await page.click('.daily-start button');
  await page.waitForFunction(() => window.__rec?.active);
  assert.match(await page.textContent('.session-meta'), /L2T Daily/);
  assert.equal(await page.$('.switch'), null, 'student questions cannot be switched off in a ranked attempt');
  assert.equal(await page.evaluate(() => window.__calls.prepare.length), 0, 'shared fixed starting knowledge, no extraction call');
  await say('so plants make their own food from sunlight water and carbon dioxide, kind of like a kitchen in the leaf, does that make sense');
  await page.waitForFunction(() => window.__calls.evaluate >= 1, null, { timeout: 8000 });
  await page.waitForTimeout(2500);
  const seen = await page.evaluate(() => [...window.__daily.tokensSeen]);
  assert.ok(seen.includes('/api/evaluate:tok-1') && seen.includes('/api/reply:tok-1'), `live calls carry the attempt token: ${seen}`);
  step('session on the shared challenge; every live call carries the signed attempt token');

  await page.click('button:has-text("End session")');
  await page.waitForSelector('.daily-banner:has-text("Official score")', { timeout: 20000 });
  const sub = await page.evaluate(() => window.__daily.submits[0]);
  assert.equal(sub.token, 'tok-1');
  assert.equal(sub.score, undefined, 'the client never sends a score');
  assert.ok(sub.utterances.length >= 1);
  assert.match(await page.textContent('.daily-banner'), /71\/100.*rank 1 of 2/);
  await shot('d1-results');
  step('results show the server-scored result and rank; the client sends only the transcript');

  await page.click('.daily-banner button:has-text("Leaderboard")');
  await page.waitForSelector('.daily-board table');
  const rows = await page.$$eval('.daily-board tbody tr', (n) => n.map((r) => r.textContent));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /1.*Ada.*you.*71/);
  assert.match(await page.textContent('.daily-stats'), /Your best today\s*71/);
  assert.equal(await page.textContent('.daily-start button'), 'Try again');
  assert.equal(await page.inputValue('.daily-start input'), 'Ada', 'username remembered');
  await shot('d2-leaderboard');
  step('leaderboard: rank, username, score; personal best; retry available');

  await page.click('.daily-start button');
  await page.waitForFunction(() => window.__rec?.active);
  await say('photosynthesis means plants turn light into sugar using water and carbon dioxide from the air around them');
  await page.waitForTimeout(1500);
  await page.click('button:has-text("End session")');
  await page.waitForSelector('.daily-banner:has-text("best today 72")', { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__daily.starts.at(-1).userId), 'a'.repeat(20), 'same signed identity reused');
  step('retry counted; best attempt kept');

  assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
  step('no console errors');
  console.log('\nALL L2T DAILY CHECKS PASSED');
} catch (e) {
  await shot('daily-failure').catch(() => {});
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
