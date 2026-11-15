import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DAILY_CHALLENGES, challengeFor, dayKey, nextResetAt, publicChallenge } from '../lib/daily/schedule.ts';
import { memoryStore, fileStore, redisStore } from '../lib/daily/store.ts';
import {
  startAttempt, recordEvent, submitAttempt, leaderboard, verifyAttempt, signAttempt, cleanUsername, rebuildAndScore,
  conceptIdFor, DailyError, LIMITS, type DailyDeps,
} from '../lib/daily/service.ts';
import { sanitizeExtraction } from '../lib/student/knowledge.ts';

const T0 = Date.parse('2026-11-14T15:00:00Z');
function deps(store = memoryStore(() => clock.now)) {
  return { store, secret: 'test-secret', now: () => clock.now } as DailyDeps;
}
const clock = { now: T0 };

// A good 90-second attempt: the server records what the AI evaluated; the
// client sends its transcript.
const P = (o: any = {}) => ({ concepts: [], misconceptions: [], undefined_terms: [], question_response: { quality: 'none', quote: '' }, checked_understanding: { happened: false, quote: '' }, ...o });
const C = (id: string, quote: string, correctness = 'correct', extra: any = {}) => ({ concept_id: id, explained: true, correctness, clarity: 'clear', level_fit: 'appropriate', used_example: false, quote, gap: '', ...extra });
const GOOD = [
  { at: 5, t: 'photosynthesis is how plants make their own food, sugar, from carbon dioxide and water using light energy', p: P({ concepts: [C('c1', 'plants make their own food, sugar, from carbon dioxide and water using light energy')] }) },
  { at: 30, t: 'the chlorophyll in the chloroplasts absorbs mostly red and blue light and that energy powers it, does that make sense', p: P({ concepts: [C('c2', 'chlorophyll in the chloroplasts absorbs mostly red and blue light')], checked_understanding: { happened: true, quote: 'does that make sense' } }) },
  { at: 60, t: 'no the soil only gives water and minerals, the plant builds the sugar itself, and the oxygen comes from splitting water', p: P({ concepts: [C('c3', 'the oxygen comes from splitting water')], misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the soil only gives water and minerals' }], question_response: { quality: 'full', quote: 'the soil only gives water and minerals' } }) },
];
const STUDENT_Q = "Wait, but don't plants get their food from the soil?";
const transcript = (extra: any[] = []) => [
  ...GOOD.map((g, i) => ({ speaker: 'teacher', text: g.t, start: g.at, end: g.at + 12 })),
  { speaker: 'student', text: STUDENT_Q, start: 50, end: 53 },
  ...extra,
];

async function play(d: DailyDeps, token: string, opts: { good?: boolean } = { good: true }) {
  const day = verifyAttempt(d.secret, token).d;
  for (const [i, g] of GOOD.entries()) {
    clock.now = verifyAttempt(d.secret, token).t + g.at * 1000;
    if (i === 2) {
      await recordEvent(d, token, { k: 'reply', text: STUDENT_Q, intent: 'misconception', conceptId: 'c1', misconceptionId: 'm1' } as any);
      clock.now += 2000;
    }
    const proposal = opts.good ? g.p : P({ concepts: [C(g.p.concepts[0].concept_id, g.p.concepts[0].quote, 'incorrect')] });
    await recordEvent(d, token, { k: 'eval', segment: g.t, proposal } as any);
  }
  void day;
}

test('schedule: one fixed challenge per UTC day, rotating, resetting at UTC midnight', () => {
  assert.equal(dayKey(T0), '2026-11-14');
  assert.equal(dayKey(Date.parse('2026-11-14T23:59:59Z')), '2026-11-14');
  assert.equal(dayKey(Date.parse('2026-11-15T00:00:00Z')), '2026-11-15');
  assert.equal(nextResetAt(T0), Date.parse('2026-11-15T00:00:00Z'));
  assert.equal(challengeFor('2026-11-14').id, challengeFor('2026-11-14').id, 'same day, same challenge for everyone');
  const week = Array.from({ length: DAILY_CHALLENGES.length }, (_, i) => challengeFor(dayKey(T0 + i * 86400000)).id);
  assert.equal(new Set(week).size, DAILY_CHALLENGES.length, 'rotates through every challenge');
  for (const c of DAILY_CHALLENGES) {
    const clean = sanitizeExtraction(c.extraction, false);
    assert.equal(clean.concepts.length, 3, `${c.id} keeps its 3 concepts`);
    assert.equal(clean.misconceptions.length, 2);
    assert.deepEqual(c.objectives, c.extraction.concepts.map((x) => x.name));
  }
  assert.ok(publicChallenge('2026-11-14').extraction, 'same initial student knowledge is shared');
});

test('tokens and usernames: signed, tamper-proof, sanitized', () => {
  const tok = signAttempt('s', { d: '2026-11-14', u: 'a'.repeat(20), a: 'x', t: 1 });
  assert.equal(verifyAttempt('s', tok).a, 'x');
  assert.throws(() => verifyAttempt('other', tok), DailyError);
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ d: '2026-11-14', u: 'b'.repeat(20), a: 'x', t: 1 })).toString('base64url');
  assert.throws(() => verifyAttempt('s', `${forged}.${sig}`), DailyError);
  void body;
  assert.equal(cleanUsername('  Ada <script>Lovelace</script> '), 'Ada scriptLovelacesc');
  assert.throws(() => cleanUsername('!'), DailyError);
});

test('server scores from what it recorded; the client cannot send a score or invent lines', async () => {
  clock.now = T0;
  const d = deps();
  const s = await startAttempt(d, { username: 'Ada' });
  assert.equal(s.challenge.id, challengeFor('2026-11-14').id);
  await play(d, s.token);
  clock.now = T0 + 95_000;
  const fake = { speaker: 'teacher', text: 'I checked in with the student many many times and they understood everything perfectly', start: 70, end: 80 };
  const r = await submitAttempt(d, { token: s.token, userId: s.userId, userSig: s.userSig, utterances: transcript([fake]), score: 100 } as any);
  assert.equal(r.eligible, true, r.reasons.join());
  assert.equal(r.droppedLines, 1, 'a line the server never evaluated is dropped');
  assert.ok(r.score! >= 60 && r.score! <= 100, `score ${r.score}`);
  assert.equal(r.rank, 1);
  // Same events, same score: rebuild is deterministic.
  const again = rebuildAndScore('2026-11-14', (await d.store.lrange(`l2t:ev:${verifyAttempt(d.secret, s.token).a}`)).map((x) => JSON.parse(x)), transcript(), 95);
  assert.equal(again.scores.overall, r.score);
});

test('single use, time limits, ownership, rate limits', async () => {
  clock.now = T0;
  const d = deps();
  const s = await startAttempt(d, { username: 'Ada' });
  await play(d, s.token);
  clock.now = T0 + 20_000;
  const early = await submitAttempt(d, { token: s.token, userId: s.userId, userSig: s.userSig, utterances: transcript() });
  assert.equal(early.eligible, false, 'too short to count');
  await assert.rejects(submitAttempt(d, { token: s.token, userId: s.userId, userSig: s.userSig, utterances: transcript() }), /already submitted/);
  const s2 = await startAttempt(d, { username: 'Ada', userId: s.userId, userSig: s.userSig });
  assert.equal(s2.userId, s.userId, 'same signed user id is kept');
  const stolen = await startAttempt(d, { username: 'Eve', userId: s.userId, userSig: 'forged' });
  assert.notEqual(stolen.userId, s.userId, "can't reuse someone else's id without its signature");
  await assert.rejects(submitAttempt(d, { token: s2.token, userId: stolen.userId, userSig: stolen.userSig, utterances: [] }), /different user/);
  clock.now = verifyAttempt(d.secret, s2.token).t + (120 + LIMITS.graceAfterLimitSec + 5) * 1000;
  await assert.rejects(submitAttempt(d, { token: s2.token, userId: s.userId, userSig: s.userSig, utterances: [] }), /expired/);
  clock.now = T0;
  const d2 = deps();
  for (let i = 0; i < LIMITS.startsPerDay; i++) await startAttempt(d2, { username: 'Bot', userId: s.userId, userSig: s.userSig });
  await assert.rejects(startAttempt(d2, { username: 'Bot', userId: s.userId, userSig: s.userSig }), /limit/);
});

test('leaderboard: best eligible attempt per user per day, ranked; resets daily', async () => {
  clock.now = T0;
  const d = deps();
  const run = async (name: string, good: boolean, creds: any = {}) => {
    clock.now = T0 + Math.floor(Math.random() * 1000);
    const s = await startAttempt(d, { username: name, ...creds });
    await play(d, s.token, { good });
    clock.now = verifyAttempt(d.secret, s.token).t + 95_000;
    return { s, r: await submitAttempt(d, { token: s.token, userId: s.userId, userSig: s.userSig, utterances: transcript() }) };
  };
  const a1 = await run('Ada', false);
  const b = await run('Bea', true);
  const a2 = await run('Ada', true, { userId: a1.s.userId, userSig: a1.s.userSig });
  const a3 = await run('Ada', false, { userId: a1.s.userId, userSig: a1.s.userSig });
  assert.ok(a2.r.score! > a1.r.score!, `${a1.r.score} -> ${a2.r.score}`);
  assert.equal(a3.r.best!.score, a2.r.score, 'a worse retry never lowers the best');
  const board = await leaderboard(d, '2026-11-14', a1.s.userId);
  assert.equal(board.total, 2, 'one row per user');
  assert.deepEqual(board.entries.map((e) => e.username).sort(), ['Ada', 'Bea']);
  assert.equal(board.me!.score, a2.r.score);
  assert.ok(board.entries[0].score >= board.entries[1].score);
  assert.ok(!('userId' in board.entries[0]), 'user ids are not exposed');
  assert.equal(b.r.eligible, true);
  assert.equal((await leaderboard(d, '2026-11-15')).total, 0, 'new day, empty board');
});

test('recording ignores unknown names and stops after submission', async () => {
  assert.equal(conceptIdFor('2026-11-14', challengeFor('2026-11-14').extraction.concepts[1].name.toUpperCase()), 'c2');
  assert.equal(conceptIdFor('2026-11-14', 'nope'), null);
});

test('file store persists across instances (shared on one server)', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'l2t-')), 'daily.json');
  const a = fileStore(file);
  await a.hset('l2t:2026-11-14:board', 'u1', '{"score":1}');
  await Promise.all([a.incr('n'), a.incr('n'), a.incr('n')]);
  const b = fileStore(file);
  assert.deepEqual(await b.hgetall('l2t:2026-11-14:board'), { u1: '{"score":1}' });
  assert.equal(await b.get('n'), '3', 'concurrent increments serialized');
  assert.equal(await b.setNX('k', 'v'), true);
  assert.equal(await b.setNX('k', 'w'), false);
});

test('redis REST store sends the right commands', async () => {
  const sent: any[] = [];
  const fake = (async (_url: string, init: any) => {
    const cmd = JSON.parse(init.body);
    sent.push(cmd);
    const result = cmd[0] === 'HGETALL' ? ['u1', '{"score":5}'] : cmd[0] === 'INCR' ? 1 : cmd[0] === 'SET' ? 'OK' : null;
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  const r = redisStore('https://example.upstash.io', 'tok', fake);
  assert.equal(await r.incr('k', 60), 1);
  assert.equal(await r.setNX('s', '1', 60), true);
  assert.deepEqual(await r.hgetall('h'), { u1: '{"score":5}' });
  assert.deepEqual(sent.map((c) => c[0]), ['INCR', 'EXPIRE', 'SET', 'HGETALL']);
  assert.deepEqual(sent[2], ['SET', 's', '1', 'NX', 'EX', '60']);
});

test('daily reset: an attempt from before midnight UTC counts for its own day only within the grace period', async () => {
  const d = deps();
  clock.now = Date.parse('2026-11-14T23:58:00Z');
  const s = await startAttempt(d, { username: 'Ada' });
  await play(d, s.token);
  clock.now = Date.parse('2026-11-15T00:00:30Z');
  const r = await submitAttempt(d, { token: s.token, userId: s.userId, userSig: s.userSig, utterances: transcript() });
  assert.equal(r.day, '2026-11-14', 'scored on the day it was started');
  assert.equal((await leaderboard(d, '2026-11-15')).total, 0, "doesn't leak into the new day");
  clock.now = Date.parse('2026-11-14T23:50:00Z');
  const s2 = await startAttempt(d, { username: 'Ada', userId: s.userId, userSig: s.userSig });
  clock.now = Date.parse('2026-11-15T00:16:00Z');
  await assert.rejects(submitAttempt(d, { token: s2.token, userId: s.userId, userSig: s.userSig, utterances: [] }), /earlier day|expired/);
  assert.notEqual(challengeFor('2026-11-14').id, challengeFor('2026-11-15').id, 'new challenge after reset');
});
