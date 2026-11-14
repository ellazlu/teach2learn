// End-to-end UI check with simulated speech, voice and API. Usage:
//   bash tests/browser/run.sh      (needs Playwright + Chromium: npx playwright install chromium)

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// Tiny solid-color PNGs stand in for the team's avatar art.
import { deflateSync } from 'node:zlib';
function png(r, g, b, size = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const AVATAR_FRAMES = { listening: [200, 200, 200], confused: [240, 160, 60], 'talking-1': [60, 120, 240], 'talking-2': [140, 180, 250] };

const files = {
  '/avatar/avatar.json': ['application/json', JSON.stringify({ format: 'png', frames: Object.keys(AVATAR_FRAMES) })],
  ...Object.fromEntries(Object.entries(AVATAR_FRAMES).map(([n, c]) => [`/avatar/${n}.png`, ['image/png', png(...c)]])),
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
const ttsCount = () => page.evaluate(() => window.__ttsCalls.length);
const waitTts = (n) => page.waitForFunction((k) => window.__ttsCalls.length >= k, n, { timeout: 8000 });

try {
  await page.goto(url);
  await shot('0-setup');
  await page.fill('.topic-input', 'Photosynthesis');
  await page.click('.segmented button:has-text("Middle schooler")');
  await page.click('.segmented button:has-text("2 min")');
  await page.click('button:has-text("Start session")');
  await page.waitForSelector('.session-bar');
  assert.equal(await page.evaluate(() => window.__rec.active), true);
  step('Start session goes straight into a live session; mic on');
  await page.waitForSelector('.avatar.has-art img[src="/avatar/listening.png"]');
  step('avatar uses the hand-drawn frames from public/avatar (listening frame)');
  const seen = new Set();
  const watch = setInterval(() => page.$eval('.av-img', (i) => i.getAttribute('src')).then((x) => seen.add(x)).catch(() => {}), 40);

  // 1) Teacher explains; student objects with its misconception, quickly.
  await page.waitForTimeout(300);
  await say('okay so today is photosynthesis, plants make their own food using sunlight water and air, kind of like a kitchen inside the thylakoid');
  await waitTts(1);
  const firstReplyMs = await page.evaluate(() => window.__ttsCalls[0].at - window.__finalAt);
  const first = await page.evaluate(() => window.__ttsCalls[0].text);
  assert.match(first, /eat dirt/);
  assert.deepEqual(await page.evaluate(() => window.__calls.reply), ['misconception']);
  step(`student replied to what was just said, ${Math.round(firstReplyMs)} ms after the teacher's speech ended (simulated APIs)`);
  assert.equal(await page.evaluate(() => window.__ttsCalls[0].voice), 'Google US English', 'natural browser voice chosen over the default');
  await page.waitForSelector('.avatar.b-responding');
  await page.waitForTimeout(400);
  clearInterval(watch);
  assert.ok(seen.has('/avatar/talking-1.png') && seen.has('/avatar/talking-2.png'), `talking frames alternate while speaking (saw ${[...seen]})`);
  step('talking frames alternate while the student speaks');
  assert.equal(await page.evaluate(() => window.__rec.active), false);
  assert.equal(await say('wait but dont plants eat dirt'), false);
  step('mic paused while the student talks (its voice is never transcribed)');
  await shot('1-student-talks');
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  step('back to listening after the student finishes');

  // 2) Teacher answers; student reacts to the answer (not a new disconnected question).
  await say('no, actually the soil only gives water and minerals, the food is sugar made in the leaves using light from the sun');
  await waitTts(3);
  assert.equal((await page.evaluate(() => window.__calls.reply))[1], 'react_to_answer');
  await page.waitForFunction(() => document.querySelector('.panel')?.textContent.includes('Corrected'), null, { timeout: 8000 });
  step('student reacted to the answer; background evaluation marked the misconception corrected');
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });

  // 3) Background evaluation failure doesn't stop the conversation.
  await page.evaluate(() => (window.__failNextEvaluate = true));
  await say('and plants also need carbon dioxide from the air which goes in through tiny holes in the leaves');
  await page.waitForTimeout(1800);
  assert.match(await page.textContent('.debug'), /conversation unaffected|following along|letting the teacher continue/);
  step('a failed background evaluation leaves the conversation running');

  // 4) Teacher checks understanding -> student explains back -> verified.
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  const before = await ttsCount();
  await say('so plants make their own food from light, does that make sense');
  await waitTts(before + 1);
  assert.ok((await page.evaluate(() => window.__calls.reply)).includes('explain_back'));
  await page.waitForFunction(() => document.querySelector('.panel')?.textContent.includes('Demonstrated'), null, { timeout: 8000 });
  step('teacher checked understanding -> student explained it back -> verified as demonstrated');
  await shot('2-session');

  // 5) End -> concise feedback.
  await page.click('button:has-text("End session")');
  await page.waitForSelector('.results', { timeout: 15000 });
  const results = await page.textContent('main');
  for (const s of ['Your teaching', 'What went well', 'What to improve', 'Try next time', 'Student understanding', 'Demonstrated understanding', 'Not yet verified']) {
    assert.ok(results.includes(s), `results include "${s}"`);
  }
  assert.doesNotMatch(results, /rubric|score|\d+%\s*(mastery)/i);
  assert.equal(await page.$$eval('.three-item', (n) => n.length), 3);
  assert.equal(await page.textContent('.stats .stat:nth-child(4) .stat-v'), '1', 'the check-in was counted');
  const q = await page.$eval('.evidence q', (el) => getComputedStyle(el, '::before').content);
  assert.equal(q, 'open-quote');
  step('feedback: exactly three teaching items + concept summary with the three verification labels');
  await shot('3-results');

  // 6) Persistence.
  await page.reload();
  await page.click('button:has-text("History")');
  await page.click('.history-open');
  await page.waitForSelector('.results');
  step('session restored from history after reload');

  // 7) No art yet -> placeholder face, and a missing expression falls back to listening.
  const bare = await context.newPage();
  await bare.route('**/avatar/avatar.json', (r) => r.fulfill({ contentType: 'application/json', body: '{"format":"png","frames":[]}' }));
  await bare.goto(url);
  await bare.fill('.topic-input', 'Photosynthesis');
  await bare.click('button:has-text("Start session")');
  await bare.waitForSelector('.avatar .av-svg');
  assert.equal(await bare.$('.av-img'), null);
  await bare.close();
  step('with no art listed, the built-in placeholder face is used');

  // 8) Mobile layout.
  const mobile = await page.context().newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(url);
  await mobile.click('button:has-text("History")');
  await mobile.click('.history-open');
  await mobile.waitForSelector('.results');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal overflow on mobile (${overflow}px)`);
  await shot('4-mobile-results', mobile);
  step('mobile layout has no horizontal overflow');

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  step('no console errors');
  console.log(`\nLATENCY first reply: ${Math.round(firstReplyMs)} ms`);
  console.log('ALL BROWSER CHECKS PASSED');
} catch (e) {
  await shot('failure');
  console.error('FAILED:', e.message, '\nerrors:', errors, '\nlog:', (await page.evaluate(() => window.__log).catch(() => [])).slice(-30));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
