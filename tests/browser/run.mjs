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
// The middle-school character has its own frames; other levels use the shared default.
const AVATAR_FRAMES = { listening: [200, 200, 200], confused: [240, 160, 60], 'talking-1': [60, 120, 240], 'talking-2': [140, 180, 250] };
const manifest = (frames) => ['application/json', JSON.stringify({ format: 'png', frames })];

const files = {
  '/avatar/avatar.json': manifest(['listening']),
  '/avatar/listening.png': ['image/png', png(120, 120, 120)],
  '/avatar/middle/avatar.json': manifest(Object.keys(AVATAR_FRAMES)),
  ...Object.fromEntries(Object.entries(AVATAR_FRAMES).map(([n, c]) => [`/avatar/middle/${n}.png`, ['image/png', png(...c)]])),
  ...Object.fromEntries(['kindergarten', 'high', 'college', 'expert'].map((l) => [`/avatar/${l}/avatar.json`, manifest([])])),
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
  await page.waitForSelector('.avatar.has-art img[src="/avatar/middle/listening.png"]');
  step("avatar uses the middle-school character's own frames");
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
  assert.ok(seen.has('/avatar/middle/talking-1.png') && seen.has('/avatar/middle/talking-2.png'), `talking frames alternate while speaking (saw ${[...seen]})`);
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
  assert.doesNotMatch(results, /\d+%\s*(mastery)/i);
  assert.equal(await page.$$eval('.three-item', (n) => n.length), 3);
  const ratings = await page.$$eval('.rating', (els) => els.map((e) => ({ label: e.querySelector('.rating-label').textContent, score: e.querySelector('.rating-score')?.textContent || e.querySelector('.rating-na')?.textContent, why: e.querySelector('.rating-why').textContent })));
  assert.deepEqual(ratings.map((r) => r.label), ['Engagement', 'Communication', 'Teaching effectiveness']);
  assert.ok(ratings.every((r) => /^\d{1,3}\/100$/.test(r.score) || r.score === 'Not enough evidence') && ratings.every((r) => r.why.length > 10), JSON.stringify(ratings));
  const num = (x) => Number(x.split('/')[0]);
  assert.ok(num(ratings[2].score) >= 70, `teaching: misconception resolved + demonstrated (${ratings[2].score})`);
  assert.ok(num(ratings[1].score) < 100, `communication: one term beyond a middle schooler (thylakoid) costs a little (${ratings[1].score})`);
  const overall = await page.textContent('.overall-score');
  assert.match(overall, /^\d{1,3}\/100$/);
  step(`0-100 scores with explanations: ${ratings.map((r) => r.score).join(', ')}; overall ${overall}`);
  await page.click('.evidence-details summary');
  assert.equal(await page.textContent('.stats .stat:nth-child(4) .stat-v'), '1', 'the check-in was counted');
  assert.equal(await page.$$eval('.rubric-item', (n) => n.length), 3);
  assert.ok((await page.$$('.criteria-table tr')).length >= 12, 'every weighted criterion is shown with its points');
  assert.ok((await page.$$('.evidence-list li')).length >= 3);
  step('expandable evidence section: evidence list, speech stats, weighted criteria with points per category');
  const q = await page.$eval('.evidence q', (el) => getComputedStyle(el, '::before').content);
  assert.equal(q, 'open-quote');
  step('feedback: exactly three teaching items + concept summary with the three verification labels');
  await page.waitForSelector('.challenge-card button:has-text("Start next challenge")', { timeout: 8000 });
  const card = await page.textContent('.challenge-card');
  assert.match(card, /Why:/);
  assert.equal(await page.evaluate(() => window.__calls.coach.length), 1, 'coach ran once, after feedback');
  assert.equal(await page.evaluate(() => window.__calls.coach[0].history.sessions.length), 0, 'first-time user: no history');
  step('coach ran in the background after feedback and set a challenge (prominent Next Challenge button)');
  await shot('3-results');

  // 5b) Next Challenge launches the coach's scenario directly into a session.
  const challengeTitle = await page.textContent('.challenge-card .next h3');
  await page.click('.challenge-card button:has-text("Start next challenge")');
  await page.waitForSelector('.challenge-goal');
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  step(`Next Challenge ("${challengeTitle}") started a session with its goal shown`);
  await say('so plants make their own food from sunlight water and air, the soil only gives water and minerals, the food is sugar made in the leaves, does that make sense');
  await page.waitForFunction(() => window.__calls.reply.length >= 4, null, { timeout: 8000 });
  const personas = await page.evaluate(() => window.__calls.personas);
  assert.ok(personas.at(-1).length > 20, 'the student plays the scenario profile');
  step('the simulated student received the challenge scenario profile');
  await page.waitForFunction(() => window.__rec?.active, null, { timeout: 8000 });
  await say('and the food the plant makes is sugar which it uses to grow, so the leaves are where the cooking happens');
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window.__coachFail = true));
  await page.click('button:has-text("End session")');
  await page.waitForSelector('.results', { timeout: 15000 });
  await page.waitForSelector('.challenge-card .outcome .criteria li', { timeout: 8000 });
  const outcome = await page.textContent('.challenge-card .outcome');
  assert.ok(outcome.includes(challengeTitle), 'attempted challenge shown');
  assert.match(outcome, /you: |not enough evidence/);
  await page.waitForSelector('.challenge-card .next button', { timeout: 8000 });
  step('attempt judged against the same criteria; coach outage handled by the in-browser fallback');
  await shot('3b-challenge-results');

  // 5c) Progress dashboard.
  await page.click('.topnav button:has-text("Progress")');
  await page.waitForSelector('.progress .chart-plot svg');
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem('teach2learn-tutor-v1')).sessions.map((x) => x.ratings));
  const expectLines = ['engagement', 'communication', 'teaching'].filter((c) => rows.every((r) => r[c] !== null)).length;
  assert.equal(await page.$$eval('.chart-plot polyline', (n) => n.length), expectLines, 'a line per category rated in both sessions (unrated = gap)');
  assert.ok(rows.every((r) => r.overall === null || (r.overall >= 0 && r.overall <= 100)));
  assert.equal(await page.$$eval('.legend li', (n) => n.length), 3);
  assert.equal(await page.$$eval('.end-label', (n) => n.length), 3, 'direct labels');
  const box = await page.$eval('.chart-plot svg', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.7, box.y + box.h / 2);
  await page.waitForSelector('.tooltip');
  assert.equal(await page.$$eval('.tooltip .tt-row', (n) => n.length), 3);
  step('progress chart: three lines, legend, direct labels, hover tooltip');
  await shot('5-progress');
  await page.click('.chart-bar button:has-text("Show as table")');
  assert.equal(await page.$$eval('.chart table tbody tr', (n) => n.length), 2);
  await page.click('.chart-bar button:has-text("Show chart")');
  assert.equal(await page.$$eval('.progress .panel table.data:not(.compact) tbody tr', (n) => n.length), 2, 'recent sessions');
  assert.ok(await page.$('.current .btn.primary'), 'current challenge with a start/retry button');
  await page.click('.coach-log summary');
  const logText = await page.textContent('.coach-log');
  assert.match(logText, /score_session/);
  assert.match(logText, /Coach service unavailable/);
  step('progress dashboard: recent sessions, current challenge, coach activity log');
  await page.click('.page-head button:has-text("Back")');

  // 6) Persistence.
  await page.reload();
  await page.click('button:has-text("History")');
  await page.click('.history-open');
  await page.waitForSelector('.results');
  step('session restored from history after reload');

  // 7) A level without its own art uses the shared character.
  const hs = await context.newPage();
  await hs.goto(url);
  await hs.fill('.topic-input', 'Photosynthesis');
  await hs.click('.segmented button:has-text("High schooler")');
  await hs.click('button:has-text("Start session")');
  await hs.waitForSelector('.avatar.has-art img[src="/avatar/listening.png"]');
  await hs.close();
  step('a level without its own art uses the shared default character');

  // 8) No art anywhere -> placeholder face.
  const bare = await context.newPage();
  await bare.route('**/avatar/**avatar.json', (r) => r.fulfill({ contentType: 'application/json', body: '{"format":"png","frames":[]}' }));
  await bare.goto(url);
  await bare.fill('.topic-input', 'Photosynthesis');
  await bare.click('button:has-text("Start session")');
  await bare.waitForSelector('.avatar .av-svg');
  assert.equal(await bare.$('.av-img'), null);
  await bare.close();
  step('with no art listed, the built-in placeholder face is used');

  // 9) Mobile layout.
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
