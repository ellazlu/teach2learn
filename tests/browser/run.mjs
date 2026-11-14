// End-to-end UI check with simulated speech. Usage (from the repo root):
//   npx esbuild tests/browser/harness.jsx --bundle --loader:.js=jsx --jsx=automatic --outfile=tests/browser/out/app.js
//   node tests/browser/run.mjs
// Requires Playwright with Chromium (npx playwright install chromium).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const files = {
  '/': ['text/html', `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`],
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
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (s) => console.log(`✓ ${s}`);
const say = (t) => page.evaluate((x) => window.__teacherSays(x), t);
const shot = (name) => page.screenshot({ path: path.join(root, `tests/browser/out/${name}.png`), fullPage: true });

try {
  await page.goto(url);
  await page.fill('.topic-input', 'Photosynthesis');
  await page.click('text=Middle schooler');
  await page.click('text=1 min');
  await page.click('button:has-text("Start session")');
  await page.waitForSelector('.session-bar');
  step('Start session goes straight into a live session');

  assert.equal(await page.evaluate(() => window.__rec.active), true);
  step('microphone started without an extra page');

  // Teacher explains (>= 25 words -> one stable segment).
  await say('okay so today we are learning photosynthesis which is how plants make their own food using sunlight water and carbon dioxide from the air kind of like a little kitchen inside the thylakoid');
  await page.waitForSelector('.speech-bubble.live', { timeout: 5000 });
  const bubble = await page.textContent('.speech-bubble');
  assert.match(bubble, /eat dirt/);
  assert.ok(await page.$('.avatar.behavior-responding'));
  assert.deepEqual(await page.evaluate(() => window.__calls.speak), ['misconception']);
  step(`student interrupted with a misconception chosen by code: "${bubble.replace('skip', '').trim()}"`);
  await shot('1-student-asks');

  // Mic is paused while the student talks; speech now is dropped (not transcribed as teacher).
  assert.equal(await page.evaluate(() => window.__rec.active), false);
  assert.equal(await say("wait but don't plants eat dirt"), false);
  step('mic paused while the student speaks (its voice is never transcribed as the teacher)');

  await page.waitForSelector('.speech-bubble:not(.live)', { timeout: 5000 });
  await page.waitForFunction(() => window.__rec.active, null, { timeout: 3000 });
  assert.ok(await page.$('.avatar.behavior-listening'));
  step('back to listening; mic resumed');

  // Panel shows the model; misconception is active.
  await page.click('.panel-toggle');
  const before = await page.textContent('.student-panel');
  assert.match(before, /believes it/);
  assert.match(before, /What photosynthesis is/);
  step('understanding panel shows concepts, mastery and the active misconception');

  // A simulated API outage keeps state and the session continues.
  const masteryBefore = await page.textContent('.concept-bar');
  await page.evaluate(() => (window.__failNextEvaluate = true));
  await say('this sentence is filler to test what happens when the evaluation service fails for a moment during the lesson okay');
  await page.waitForTimeout(800);
  assert.equal(await page.textContent('.concept-bar'), masteryBefore);
  step('a failed evaluation leaves the student state unchanged');

  // Teacher answers the question -> misconception resolved, question answered.
  await say('no actually the soil only gives water and minerals but the food is sugar made in the leaves using light from the sun does that make sense');
  await page.waitForFunction(() => document.querySelector('.student-panel')?.textContent.includes('resolved'), null, { timeout: 5000 });
  step('teacher correction resolved the misconception (deterministic update)');
  await shot('2-panel-after-correction');

  // End the session -> feedback.
  await page.click('button:has-text("End session")');
  await page.waitForSelector('text=What your student learned', { timeout: 10000 });
  const results = await page.textContent('main');
  assert.match(results, /How to teach this better/);
  assert.match(results, /Resolved/);
  assert.match(results, /How you spoke/);
  assert.match(results, /thylakoid/, 'suggestion cites the undefined term');
  assert.ok((await page.$$('.evidence .ts')).length > 0, 'suggestions carry timestamps');
  assert.doesNotMatch(results, /rubric|score/i);
  step('results: learning summary, evidence-cited suggestions with timestamps, speech metrics, no rubric');
  await shot('3-results');

  // Persistence across reload.
  await page.reload();
  await page.click('button:has-text("History")');
  await page.click('.history-open');
  await page.waitForSelector('text=What your student learned');
  step('session restored from history after a page reload');

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  step('no console errors');
  console.log('\nALL BROWSER CHECKS PASSED');
} catch (e) {
  await shot('failure');
  console.error('FAILED:', e.message, '\nerrors:', errors, '\nlog:', await page.evaluate(() => window.__log).catch(() => ''));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
