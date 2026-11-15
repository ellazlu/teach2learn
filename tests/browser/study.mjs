// Teach to Learn end-to-end in headless Chromium: mode choice, checklist
// editing, live checklist tracking, whiteboard sharing, content feedback, the
// study planner, separated progress/history, and a practice retry.
// Run via tests/browser/run.sh (after the Learn to Teach flow).

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
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (s) => console.log(`✓ ${s}`);
const say = (t) => page.evaluate((x) => window.__teacherSays(x), t);
const shot = (name, p = page) => p.screenshot({ path: path.join(root, `tests/browser/out/${name}.png`), fullPage: true });
const status = (name) => page.$eval(`.checklist-live li:has-text("${name}") .status`, (e) => e.textContent);
const waitStatus = (name, text) => page.waitForFunction(([n, t]) => [...document.querySelectorAll('.checklist-live li')].some((li) => li.textContent.includes(n) && li.querySelector('.status').textContent === t), [name, text], { timeout: 10000 });
const calls = (k) => page.evaluate((x) => window.__calls[x], k);

try {
  await page.goto(url);
  // 1) Mode choice
  assert.equal(await page.$$eval('.mode-option', (n) => n.length), 2);
  assert.match(await page.textContent('.mode-pick'), /Learn to Teach — Educator[\s\S]*Teach to Learn — Student/);
  await page.click('.mode-option:has-text("Teach to Learn")');
  assert.equal(await page.textContent('.setup-actions .btn.primary'), 'Build concept checklist');
  assert.equal(await page.textContent('.segmented.compact button.on'), '5 min', 'default fits a 5-10 concept checklist');
  await page.fill('.topic-input', 'Photosynthesis');
  await page.click('.segmented button:has-text("High schooler")');
  await shot('s0-setup');
  await page.click('button:has-text("Build concept checklist")');
  await page.waitForSelector('.checklist-edit li');
  assert.equal((await calls('prepare'))[0].mode, 'student');
  await page.waitForSelector('.checklist-setup .btn.primary:has-text("Start session")', { timeout: 8000 });
  step('mode selection: Teach to Learn builds a concept checklist first');

  // 2) Checklist editing
  const names = () => page.$$eval('.checklist-edit input', (els) => els.map((e) => e.value));
  assert.equal((await names()).length, 6);
  assert.ok((await page.textContent('.checklist-setup')).indexOf('Chlorophyll is') === -1, 'no descriptions/answers shown');
  await page.fill('.checklist-edit li:nth-child(2) input', 'Chlorophyll and light');
  await page.click('.checklist-edit li:nth-child(6) [aria-label="Remove"]');
  await page.fill('.ce-add input', 'Leaf structure');
  await page.click('.ce-add button');
  await page.click('.checklist-edit li:nth-child(3) [aria-label="Move up"]');
  assert.deepEqual(await names(), ['What photosynthesis is', 'Light-dependent reactions', 'Chlorophyll and light', 'Calvin cycle', 'Limiting factors', 'Leaf structure']);
  await shot('s1-checklist');
  step('checklist: rename, remove, add and reorder before starting');

  // 3) Live session with the checklist beside it
  await page.click('button:has-text("Start session")');
  await page.waitForSelector('.checklist-live');
  await page.waitForFunction(() => window.__rec?.active);
  assert.match(await page.textContent('.session-meta'), /Teach to Learn/);
  assert.equal(await page.$$eval('.checklist-live li', (n) => n.length), 6);
  assert.equal(await status('What photosynthesis is'), 'Not covered');
  await say('photosynthesis is how plants make their own food from sunlight water and carbon dioxide, kind of like a kitchen in the leaf');
  await page.waitForFunction(() => window.__calls.replyBodies.length >= 1, null, { timeout: 8000 });
  const first = (await calls('replyBodies'))[0];
  assert.equal(first.mode, 'student');
  assert.deepEqual(first.outline, ['What photosynthesis is', 'Light-dependent reactions', 'Chlorophyll and light', 'Calvin cycle', 'Limiting factors', 'Leaf structure']);
  await waitStatus('What photosynthesis is', 'Discussed');
  step(`student probes as a curious learner (intent: ${first.intent}); explained concept -> "Discussed", not "Demonstrated"`);

  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  await say('because the light gives the energy to build the sugar out of the water and the carbon dioxide');
  await page.waitForTimeout(2600);
  step(`statuses after answering a follow-up: photosynthesis = ${await status('What photosynthesis is')}`);

  // 4) Whiteboard: draw, share, the student asks about the unclear part
  await page.click('button:has-text("Use the whiteboard")');
  await page.waitForSelector('.wb-canvas');
  const box = await page.$eval('.wb-canvas', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 40 + i * 25, box.y + 40 + i * 12);
  await page.mouse.up();
  await page.click('.wb-colors [aria-label="Blue"]');
  await page.mouse.move(box.x + 300, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 140);
  await page.mouse.up();
  await page.click('button:has-text("Undo")');
  await page.click('button:has-text("Redo")');
  assert.equal((await calls('whiteboard')).length, 0, 'nothing sent while drawing');
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  await page.click('button:has-text("Show the student")');
  await page.waitForFunction(() => window.__calls.whiteboard.length === 1, null, { timeout: 8000 });
  const wb = (await calls('whiteboard'))[0];
  assert.equal(wb.trigger, 'share');
  assert.ok(wb.image.length > 500 && wb.mediaType === 'image/png');
  await page.waitForFunction(() => window.__calls.replyBodies.some((b) => b.intent === 'board_clarify'), null, { timeout: 8000 });
  const bc = (await calls('replyBodies')).find((b) => b.intent === 'board_clarify');
  assert.equal(bc.details.focusQuestion, 'What did you write under the arrow?');
  await page.waitForFunction(() => window.__calls.evalSegments.some((x) => x.startsWith('On the whiteboard')), null, { timeout: 8000 });
  assert.match(await page.textContent('.wb-status'), /question about part of your drawing/);
  await page.click('button:has-text("Show the student")');
  assert.equal((await calls('whiteboard')).length, 1, 'unchanged board is not re-sent');
  await shot('s2-whiteboard');
  step('whiteboard: drawn with pen/colors/undo/redo; shared once; unclear part -> student asks instead of guessing');

  // 5) Manual checkmark stays separate from tracked status
  await page.check('.checklist-live li:nth-child(5) input');
  assert.equal(await status('Limiting factors'), 'Not covered', 'own tick does not change the status');
  step('manual checkmarks are kept separate from the tracked status');

  // 6) Wrong statement, then end
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  await say('and in the light reactions the oxygen comes from the carbon dioxide that the leaf takes in');
  await page.waitForTimeout(1600);
  await page.click('button:has-text("End session")');
  await page.waitForSelector('.study-results', { timeout: 20000 });
  const results = await page.textContent('.study-results');
  for (const h of ['Correct understanding', 'Knowledge gaps', 'Misconceptions', 'What to review next']) assert.ok(results.includes(h), h);
  assert.doesNotMatch(results, /Engagement|Communication|words per minute|\/5|%/, 'no delivery metrics or scores in Teach to Learn');
  assert.match(await page.textContent('.mis-feedback'), /oxygen comes from the carbon dioxide/);
  const fbCall = (await calls('studyFeedback'))[0];
  assert.ok(fbCall.boards.length >= 1 && !fbCall.boards[0].thumb, 'whiteboard evidence sent without the image');
  await page.waitForSelector('.challenge-card button:has-text("Retry this explanation")', { timeout: 8000 });
  assert.match(await page.textContent('.challenge-card'), /Light-dependent reactions/, 'planner prioritized the uncorrected error');
  assert.equal((await calls('studyPlan')).length, 1);
  await page.click('.evidence-details summary');
  assert.ok(await page.$('.board-thumb'), 'whiteboard snapshot kept with the session');
  await shot('s3-results');
  step('feedback: four content sections, misconception quoted, planner set practice for the top gap');

  // 7) Separate progress and history
  await page.click('.topnav button:has-text("Progress")');
  await page.waitForSelector('.study-progress');
  assert.equal(await page.textContent('.mode-tabs button.on'), 'Teach to Learn');
  assert.match(await page.textContent('.study-progress'), /Photosynthesis[\s\S]*Still to show/);
  await shot('s4-progress');
  await page.click('.mode-tabs button:has-text("Learn to Teach")');
  await page.waitForSelector('.progress');
  assert.match(await page.textContent('.progress'), /Finish a session to start tracking your teaching/, 'Learn to Teach progress untouched');
  await page.click('.topnav button:has-text("History")');
  assert.equal(await page.textContent('.mode-tabs button.on'), 'Teach to Learn');
  assert.equal(await page.$$eval('.history-list li', (n) => n.length), 1);
  const stored = await page.evaluate(() => Object.keys(localStorage).sort());
  assert.ok(stored.includes('teach2learn-study-history-v1') && stored.includes('teach2learn-study-v1'));
  assert.ok(!stored.includes('teach2learn-history-v4'), 'no Learn to Teach record written');
  step('progress and history are separate per mode');

  // 8) Practice retry: same checklist, student opens with the practice question
  await page.click('.mode-tabs button:has-text("Teach to Learn")');
  await page.click('.topnav button:has-text("Progress")');
  await page.click('.study-progress button:has-text("Retry this explanation")');
  await page.waitForSelector('.checklist-edit');
  assert.match(await page.textContent('.checklist-setup'), /Practice/);
  const before = await page.evaluate(() => window.__ttsCalls.length);
  await page.click('button:has-text("Start session")');
  await page.waitForFunction((n) => window.__ttsCalls.length > n, before, { timeout: 8000 });
  const opening = await page.evaluate(() => window.__ttsCalls.at(-1).text);
  assert.match(opening, /Last time you said|explain/i);
  step(`practice retry opens with the planned question: "${opening.slice(0, 60)}…"`);
  await page.click('button:has-text("Cancel")');

  // 9) Mobile: no overflow, checklist collapsible
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(url);
  await mobile.click('.mode-option:has-text("Teach to Learn")');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false);
  await shot('s5-mobile', mobile);
  step('mobile layout has no horizontal overflow');

  assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
  step('no console errors');
  console.log('\nALL TEACH TO LEARN CHECKS PASSED');
} catch (e) {
  await shot('study-failure').catch(() => {});
  console.error('FAILED:', e.message);
  console.error('log tail:', (await page.evaluate(() => window.__log.slice(-15)).catch(() => [])).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
