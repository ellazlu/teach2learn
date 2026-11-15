import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainReason, validateChallenge, evaluateCriteria, makeAttempt, templateDraft, nextDifficulty, TEMPLATES, describeCriterion, type Challenge } from '../lib/coach/challenges.ts';
import { scoreEngagement, scoreCommunication, scoreTeaching, SKILL_IDS, type SessionFacts, type Scores } from '../lib/coach/rubric.ts';
import {
  emptyProfile, loadProfile, saveProfile, addSession, applyCoachResult, seriesForChart, recurringWeaknesses,
  practiceEffect, currentChallenge, historyForCoach, PROGRESS_KEY, type SessionSummary,
} from '../lib/progress.ts';
import type { CoachResult } from '../lib/coach/types.ts';

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  levelId: 'middle', teacherWords: 200, teacherSpeakingSec: 90, studentTurns: 2, invitations: 0, studentQuestions: 0,
  answered: 0, partlyAnswered: 0, longRuns: 0, undefinedTerms: 0, unclear: 0, incorrect: 0, conceptsMentioned: 2,
  conceptsExplained: 1, demonstrated: 0, demoAttempts: 0, misconceptionsResolved: 0, misconceptionsLeftStanding: 0,
  examples: 0, wpm: null, fillersPerMin: null, maxRunSec: null, ...over,
});
const scores = (f: SessionFacts): Scores => ({ engagement: scoreEngagement(f, []), communication: scoreCommunication(f, []), teaching: scoreTeaching(f, []) });
const ctx = { sessionId: 's1', now: '2026-11-01T10:00:00Z', id: 'ch1', source: 'agent' as const };

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

// ---- Challenges -----------------------------------------------------------------

test('every template produces a valid challenge at every difficulty', () => {
  for (const skill of SKILL_IDS) {
    for (const d of [1, 2, 3] as const) {
      const r = validateChallenge(templateDraft(skill, { topic: 'Photosynthesis', levelId: 'middle', difficulty: d, reason: 'x' }), { ...ctx, difficulty: d, source: 'template' });
      assert.ok(r.ok, `${skill}@${d}: ${!r.ok && r.errors.join('; ')}`);
    }
  }
  assert.equal(Object.keys(TEMPLATES).length, SKILL_IDS.length);
});

test('validation rejects bad agent drafts with fixable messages', () => {
  const r = validateChallenge(
    { skill: 'charisma', title: '', goal: 'g', student_profile: 'p', topic: 't', level_id: 'phd', time_limit_sec: 9999, criteria: [{ metric: 'smiles', target: 3 }, { metric: 'check_ins', target: 50 }], rationale: 'r' },
    ctx,
  );
  assert.ok(!r.ok);
  const msg = r.errors.join('\n');
  for (const k of ['skill must be one of', 'level_id', 'time_limit_sec', 'title is required', 'unknown metric "smiles"', 'check_ins target must be between']) assert.ok(msg.includes(k), k);
});

test('criteria direction is fixed by the metric, not the draft', () => {
  const r = validateChallenge({ ...templateDraft('clear_language', { topic: 't', levelId: 'high', difficulty: 2, reason: 'r' }), criteria: [{ metric: 'undefined_terms', op: '>=', target: 0 }] }, ctx);
  assert.ok(r.ok);
  assert.equal(r.challenge.criteria[0].op, '<=');
  assert.equal(describeCriterion(r.challenge.criteria[0]), 'Terms used without explaining them: none');
});

test('criteria are judged met / not met / not enough evidence', () => {
  const crit = [
    { metric: 'check_ins' as const, op: '>=' as const, target: 2 },
    { metric: 'max_run_seconds' as const, op: '<=' as const, target: 60 },
    { metric: 'misconceptions_resolved' as const, op: '>=' as const, target: 1 },
  ];
  const f = facts({ invitations: 3, maxRunSec: 75 });
  const res = evaluateCriteria(crit, f, scores(f));
  assert.deepEqual(res.map((r) => r.met), [true, false, null], 'no misconception came up -> not judged');
  const a = makeAttempt('s2', 'now', res);
  assert.deepEqual([a.met, a.judged, a.total], [1, 2, 3]);
  const short = facts({ teacherWords: 10, invitations: 3 });
  assert.ok(evaluateCriteria(crit, short, scores(short)).every((r) => r.met === null), 'too-short session judges nothing');
});

test('difficulty adapts to the last attempt', () => {
  const ch = (met: number, total: number, d: 1 | 2 | 3 = 2): Challenge => ({
    ...(validateChallenge(templateDraft('checking_understanding', { topic: 't', levelId: 'middle', difficulty: d, reason: 'r' }), { ...ctx, difficulty: d, source: 'template' }) as any).challenge,
    attempts: [{ sessionId: 'x', at: 'now', met, judged: total, total, results: [] }],
  });
  assert.equal(nextDifficulty(null, 'accuracy'), 1);
  assert.equal(nextDifficulty(ch(2, 2), 'checking_understanding'), 3);
  assert.equal(nextDifficulty(ch(0, 2), 'checking_understanding'), 1);
  assert.equal(nextDifficulty(ch(1, 2), 'checking_understanding'), 2);
  assert.equal(nextDifficulty(ch(2, 2), 'accuracy'), 1, 'a different skill starts fresh');
});

// ---- Progress store ----------------------------------------------------------------

const summary = (id: string, at: string, ratings: [number | null, number | null, number | null], weak: string[] = [], challengeId: string | null = null): SessionSummary => ({
  id, at, topic: 'Photosynthesis', levelId: 'middle', timeUsedSec: 120,
  ratings: { engagement: ratings[0], communication: ratings[1], teaching: ratings[2] },
  explanations: { engagement: '', communication: '', teaching: '' },
  metrics: { wpm: null, fillersPerMin: null, maxRunSec: null, checkIns: 0, questionsAsked: 0, questionsAnswered: 0 },
  weaknesses: weak as any, focusSkill: null, challengeId,
  feedback: { went_well: '', improve: '', try_next: '' },
  student: { concepts: [], misconceptionsResolved: 0, misconceptionsTotal: 0 },
});

test('first-time user: empty profile, empty views, nothing fabricated', () => {
  const store = memStore();
  const p = loadProfile(store);
  assert.deepEqual(p, emptyProfile());
  assert.deepEqual(recurringWeaknesses(p), []);
  assert.equal(currentChallenge(p), null);
  assert.ok(seriesForChart(p).every((s) => s.points.length === 0));
  assert.deepEqual(loadProfile(null), emptyProfile(), 'no storage (server) -> empty');
  store.setItem(PROGRESS_KEY, '{not json');
  assert.deepEqual(loadProfile(store), emptyProfile(), 'corrupt storage -> empty, no throw');
});

test('sessions persist, stay ordered, and dedupe by id', () => {
  const store = memStore();
  let p = emptyProfile();
  p = addSession(p, summary('b', '2026-11-02T00:00:00Z', [3, 4, null]));
  p = addSession(p, summary('a', '2026-11-01T00:00:00Z', [2, 3, 3]));
  p = addSession(p, summary('b', '2026-11-02T00:00:00Z', [4, 4, null]));
  assert.ok(saveProfile(p, store));
  const back = loadProfile(store);
  assert.deepEqual(back.sessions.map((s) => s.id), ['a', 'b']);
  assert.equal(back.sessions[1].ratings.engagement, 4);
  const series = seriesForChart(back);
  assert.deepEqual(series.find((s) => s.category === 'teaching')!.points.map((x) => x.value), [3, null], 'unrated stays a gap');
});

test('recurring weaknesses: 2+ of last 5, with improving/persisting status', () => {
  let p = emptyProfile();
  p = addSession(p, summary('1', '2026-11-01', [3, 3, 3], ['checking_understanding', 'accuracy']));
  p = addSession(p, summary('2', '2026-11-02', [3, 3, 3], ['checking_understanding']));
  p = addSession(p, summary('3', '2026-11-03', [4, 3, 3], ['accuracy']));
  const r = recurringWeaknesses(p);
  const by = Object.fromEntries(r.map((x) => [x.skill, x]));
  assert.equal(by.checking_understanding.status, 'improving');
  assert.equal(by.accuracy.status, 'persisting');
  assert.equal(by.checking_understanding.count, 2);
  p = addSession(p, summary('4', '2026-11-04', [null, null, null], ['accuracy']));
  assert.equal(recurringWeaknesses(p).find((x) => x.skill === 'accuracy')!.status, 'persisting', 'unrated sessions are ignored');
});

function coachResult(sessionId: string, challenge: Challenge | null, outcome: CoachResult['challengeOutcome'] = null): CoachResult {
  const f = facts();
  return {
    sessionId, ratings: scores(f), evaluation: { focusSkill: 'checking_understanding', reason: 'r', evidenceIds: [] },
    challenge, challengeOutcome: outcome, trend: {} as any, recurring: [], log: [{ ms: 1, type: 'tool', name: 'score_session', detail: '' }], coachNote: '', agent: 'fallback',
  };
}

test('coach results: new challenge becomes current, attempts accrue, retries compare', () => {
  const mk = (id: string) => (validateChallenge(templateDraft('checking_understanding', { topic: 'Photosynthesis', levelId: 'middle', difficulty: 1, reason: 'r' }), { ...ctx, id, source: 'template' }) as any).challenge as Challenge;
  let p = addSession(emptyProfile(), summary('s1', '2026-11-01', [2, 3, 3], ['checking_understanding']));
  p = applyCoachResult(p, coachResult('s1', mk('ch1')));
  assert.equal(currentChallenge(p)!.id, 'ch1');
  assert.equal(p.sessions[0].focusSkill, 'checking_understanding');
  assert.equal(p.lastCoachLog!.log.length, 1);

  // Attempt 1: partly met; coach keeps the same challenge (retry).
  p = addSession(p, summary('s2', '2026-11-02', [3, 3, 3], [], 'ch1'));
  const att = (sid: string, met: number) => ({ sessionId: sid, at: sid, met, judged: 2, total: 2, results: [] });
  p = applyCoachResult(p, coachResult('s2', { ...mk('ch1') }, { challengeId: 'ch1', skill: 'checking_understanding', attempt: att('s2', 1), verdict: 'partly_addressed', adjustment: 'retry' }));
  // Attempt 2: fully met.
  p = addSession(p, summary('s3', '2026-11-03', [4, 3, 3], [], 'ch1'));
  p = applyCoachResult(p, coachResult('s3', mk('ch2'), { challengeId: 'ch1', skill: 'checking_understanding', attempt: att('s3', 2), verdict: 'addressed', adjustment: 'harder' }));
  const ch1 = p.challenges.find((c) => c.id === 'ch1')!;
  assert.deepEqual(ch1.attempts.map((a) => a.met), [1, 2]);
  assert.equal(ch1.status, 'completed');
  assert.equal(currentChallenge(p)!.id, 'ch2');
  assert.deepEqual(practiceEffect(p, ch1), { before: 2, attempts: [{ at: 's2', rating: 3, met: 1, total: 2 }, { at: 's3', rating: 4, met: 2, total: 2 }] });

  // Re-applying the same result doesn't duplicate the attempt.
  p = applyCoachResult(p, coachResult('s3', null, { challengeId: 'ch1', skill: 'checking_understanding', attempt: att('s3', 2), verdict: 'addressed', adjustment: '' }));
  assert.equal(p.challenges.find((c) => c.id === 'ch1')!.attempts.length, 2);

  const h = historyForCoach(p, 's3');
  assert.deepEqual(h.sessions.map((s) => s.id), ['s1', 's2']);
});

test('save trims oldest sessions when storage is full', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (v.length > 3000) throw new Error('quota'); m.set(k, v); } };
  let p = emptyProfile();
  for (let i = 0; i < 20; i++) p = addSession(p, summary(`s${i}`, `2026-11-${String(i + 1).padStart(2, '0')}`, [3, 3, 3]));
  assert.ok(saveProfile(p, store));
  const back = loadProfile(store);
  assert.ok(back.sessions.length < 20 && back.sessions.length > 0);
  assert.equal(back.sessions[back.sessions.length - 1].id, 's19', 'newest kept');
});

test('evidence ids are removed from text the tutor reads', () => {
  assert.equal(plainReason("open questions about orbits (E3, E5) and the Solar System's members (E2)."), "open questions about orbits and the Solar System's members.");
  assert.equal(plainReason('Unclear (E1 and E4).'), 'Unclear.');
  assert.equal(plainReason('Nothing to strip (see Earth).'), 'Nothing to strip (see Earth).');
});
