// L2T Daily routes run for real: start -> live calls recorded server-side ->
// submit scored on the server -> shared leaderboard (file store here).
import assert from 'node:assert/strict';
import { GET as daily } from './out/daily.mjs';
import { POST as start } from './out/daily-start.mjs';
import { POST as submit } from './out/daily-submit.mjs';
import { POST as evaluate } from './out/evaluate.mjs';
import { POST as reply } from './out/reply.mjs';
import { POST as verify } from './out/verify.mjs';

process.env.ANTHROPIC_API_KEY = 'test';
globalThis.__sdkCalls = [];
const req = (b) => new Request('http://x', { method: 'POST', body: JSON.stringify(b) });
const get = (q = '') => daily(new Request(`http://x/api/daily${q}`));
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

if (process.argv.includes('--read-only')) {
  const d = await (await get()).json();
  assert.ok(d.leaderboard.total >= 2, `another process sees ${d.leaderboard.total} entries`);
  console.log(`✓ leaderboard persisted on the server and shared across processes (${d.leaderboard.total} players)`);
  process.exit(0);
}

let r = await get();
let d = await r.json();
assert.equal(r.status, 200);
assert.equal(d.storage, 'file');
assert.equal(d.challenge.objectives.length, 3);
assert.ok(d.nextResetAt > d.now);
const ch = d.challenge;
assert.equal((await start(req({ username: '!' }))).status, 400, 'username required');

async function attempt(username, good, creds = {}) {
  offset = 0;
  const s = await (await start(req({ username, ...creds }))).json();
  assert.ok(s.token && s.userId && s.userSig);
  const lines = [];
  for (const [i, c] of ch.extraction.concepts.entries()) {
    offset = (10 + i * 20) * 1000;
    const text = `${c.name.toLowerCase()} means ${c.description.toLowerCase()} and does that make sense to you`;
    globalThis.__sdkReply = () => ({ concepts: [{ concept_id: c.id, explained: true, correctness: good ? 'correct' : 'incorrect', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: c.description.toLowerCase().slice(0, 60), gap: '' }], misconceptions: [], undefined_terms: [], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: true, quote: 'does that make sense' } });
    const ev = await evaluate(req({ levelId: ch.levelId, segment: text, model: { concepts: ch.extraction.concepts.map((x) => ({ id: x.id })), misconceptions: [] }, daily: s.token }));
    assert.equal(ev.status, 200);
    lines.push({ speaker: 'teacher', text, start: 10 + i * 20, end: 20 + i * 20 });
  }
  globalThis.__streamChunks = ['So the ', 'light is the energy?'];
  const rr = await reply(req({ levelId: ch.levelId, intent: 'clarify', details: { conceptName: ch.objectives[0] }, knowledge: '', conversation: [], teacherJustSaid: 'x', daily: s.token }));
  assert.equal(await rr.text(), 'So the light is the energy?');
  lines.push({ speaker: 'student', text: 'So the light is the energy?', start: 70, end: 72 });
  globalThis.__sdkReply = () => ({ verdict: good ? 'demonstrated' : 'not_demonstrated', note: '' });
  await verify(req({ levelId: ch.levelId, concept: { name: ch.objectives[0], description: 'd' }, mode: 'explain_back', statement: 'So the light is the energy?', daily: s.token }));
  return { s, lines };
}

// Too-short attempt: recorded but not eligible.
const early = await attempt('Ada', true);
offset = 20_000;
let out = await (await submit(req({ token: early.s.token, userId: early.s.userId, userSig: early.s.userSig, utterances: early.lines, score: 100 }))).json();
assert.equal(out.eligible, false);
assert.match(out.reasons.join(), /shorter than/);
assert.equal((await submit(req({ token: early.s.token, userId: early.s.userId, userSig: early.s.userSig, utterances: early.lines }))).status, 409, 'single use');

// Eligible attempts. The client's claimed score is ignored.
const creds = { userId: early.s.userId, userSig: early.s.userSig };
const good = await attempt('Ada', true, creds);
offset = 95_000;
out = await (await submit(req({ token: good.s.token, ...creds, utterances: good.lines, score: 3 }))).json();
assert.equal(out.eligible, true, out.reasons?.join());
assert.ok(out.score >= 60, `server score ${out.score}`);
const goodScore = out.score;
const bad = await attempt('Bob', false);
offset = 95_000;
const outBad = await (await submit(req({ token: bad.s.token, userId: bad.s.userId, userSig: bad.s.userSig, utterances: bad.lines, score: 100 }))).json();
assert.ok(outBad.score < goodScore, `errors score lower: ${outBad.score} < ${goodScore}`);
// A forged transcript line is dropped, not scored.
const extra = await attempt('Ada', true, creds);
offset = 95_000;
out = await (await submit(req({ token: extra.s.token, ...creds, utterances: [...extra.lines, { speaker: 'student', text: 'Wow I understand everything now, amazing teacher', start: 80, end: 81 }] }))).json();
assert.equal(out.droppedLines, 1);
assert.equal(out.best.score, goodScore, 'best attempt kept');
// Tampered token.
assert.equal((await submit(req({ token: good.s.token.replace(/.$/, 'x'), ...creds, utterances: [] }))).status, 403);

r = await get(`?userId=${creds.userId}`);
d = await r.json();
assert.equal(d.leaderboard.total, 2);
assert.equal(d.leaderboard.entries[0].username, 'Ada');
assert.equal(d.leaderboard.me.rank, 1);
assert.ok(!JSON.stringify(d.leaderboard).includes(creds.userId), 'user ids never exposed');
console.log(`✓ /api/daily: shared challenge, signed single-use attempts, live calls recorded, server-side score (${goodScore} vs ${outBad.score}), best attempt per user, leaderboard`);
