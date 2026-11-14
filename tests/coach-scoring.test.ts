import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEngagement, scoreCommunication, scoreTeaching, scoreSession, factsFrom, weaknesses, type SessionFacts } from '../lib/coach/rubric.ts';
import { initStudentModel, applyEvaluation, applyVerification } from '../lib/student/knowledge.ts';
import { recordQuestion } from '../lib/student/questions.ts';
import { computeSpeechMetrics } from '../lib/student/speech.ts';
import { buildEvidence } from '../lib/student/evidence.ts';
import { learningSummary } from '../lib/student/knowledge.ts';
import { EXTRACTION, seg, proposal, goodC1 } from './fixtures.ts';
import type { Segment } from '../lib/student/types.ts';

const base = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  levelId: 'middle', teacherWords: 200, teacherSpeakingSec: 90, studentTurns: 2, invitations: 0, studentQuestions: 0,
  answered: 0, partlyAnswered: 0, longRuns: 0, undefinedTerms: 0, unclear: 0, incorrect: 0, conceptsMentioned: 2,
  conceptsExplained: 1, demonstrated: 0, demoAttempts: 0, misconceptionsResolved: 0, misconceptionsLeftStanding: 0,
  examples: 0, wpm: null, fillersPerMin: null, maxRunSec: null, ...over,
});

test('too little speech -> "Not enough evidence" for every category', () => {
  const f = base({ teacherWords: 25 });
  for (const r of [scoreEngagement(f, []), scoreCommunication(f, []), scoreTeaching(f, [])]) {
    assert.equal(r.score, null);
    assert.match(r.explanation, /^Not enough evidence/);
  }
});

test('teaching needs the topic to come up before it is rated', () => {
  const r = scoreTeaching(base({ conceptsMentioned: 0, conceptsExplained: 0 }), []);
  assert.equal(r.score, null);
});

test('scores are deterministic and clamp to 1..5', () => {
  const f = base({ invitations: 2, studentQuestions: 4, answered: 4 });
  assert.deepEqual(scoreEngagement(f, []), scoreEngagement(f, []));
  assert.equal(scoreEngagement(f, []).score, 5);
  const bad = base({ invitations: 0, studentTurns: 0, studentQuestions: 4, answered: 0, longRuns: 1 });
  assert.equal(scoreEngagement(bad, []).score, 1);
  const worst = base({ undefinedTerms: 5, unclear: 4, fillersPerMin: 12, wpm: 240 });
  assert.equal(scoreCommunication(worst, []).score, 1);
});

test('more check-ins or more talking is not rewarded beyond the first', () => {
  const one = scoreEngagement(base({ invitations: 1 }), []).score;
  const ten = scoreEngagement(base({ invitations: 10 }), []).score;
  assert.equal(one, ten);
  const short = scoreCommunication(base({ teacherWords: 150 }), []).score;
  const long = scoreCommunication(base({ teacherWords: 900 }), []).score;
  assert.equal(short, long);
});

test('pace and fillers only count when measured; pauses never count', () => {
  const unmeasured = scoreCommunication(base({ wpm: null, fillersPerMin: null }), []);
  const measuredFine = scoreCommunication(base({ wpm: 140, fillersPerMin: 3 }), []);
  assert.equal(unmeasured.score, measuredFine.score);
  assert.equal(scoreCommunication(base({ wpm: 230 }), []).score, unmeasured.score! - 1);
  // SessionFacts has no pause input at all: long pauses can't lower a score.
  assert.ok(!('longPauses' in base()));
});

test('explaining is not learning: teaching is capped at 4 without a demonstration', () => {
  const noDemo = scoreTeaching(base({ conceptsExplained: 3, misconceptionsResolved: 1, examples: 2 }), []);
  assert.equal(noDemo.score, 4);
  assert.match(noDemo.explanation, /Capped/);
  const demo = scoreTeaching(base({ conceptsExplained: 3, misconceptionsResolved: 1, examples: 2, demonstrated: 1 }), []);
  assert.equal(demo.score, 5);
});

test('explanation names the deciding factor and weaknesses map to skills', () => {
  const s = {
    engagement: scoreEngagement(base({ longRuns: 1 }), []),
    communication: scoreCommunication(base({ undefinedTerms: 2 }), []),
    teaching: scoreTeaching(base({ incorrect: 1 }), []),
  };
  assert.match(s.communication.explanation, /2 terms without explaining them/);
  const w = weaknesses(s).map((x) => x.skill);
  assert.equal(w[0], 'clear_language', 'the -2 factor is the most severe');
  assert.ok(w.includes('accuracy') && w.includes('student_participation'));
});

test('factsFrom reads a real session: model, events, metrics and evidence', () => {
  const T = (text: string, start: number, end: number): Segment => ({ id: `t${start}`, speaker: 'teacher', text, start, end });
  let m = initStudentModel(EXTRACTION, 'middle');
  const initial = structuredClone(m);
  const events: any[] = [];
  let r = applyEvaluation(m, seg('plants make their own food using sunlight water and carbon dioxide from the air', 5), goodC1);
  events.push(...r.events);
  r = applyEvaluation(r.model, seg('inside the thylakoid photolysis happens', 40), proposal({ undefined_terms: [{ term: 'thylakoid', quote: 'inside the thylakoid' }] }));
  events.push(...r.events);
  m = recordQuestion(r.model, { kind: 'question', type: 'clarify', conceptId: 'c1', misconceptionId: null, followsQuestionId: null, reason: '', score: 1 }, 'Where does the food go?', 50);
  const v = applyVerification(m, 'c1', { at: 60, mode: 'explain_back', text: 'they make sugar from light', verdict: 'demonstrated', note: 'ok' });
  m = v.model;
  events.push(...v.events);
  const utterances = [
    T('plants make their own food using sunlight water and carbon dioxide from the air, does that make sense to you', 0, 20),
    T('inside the thylakoid photolysis happens and that splits the water so oxygen is released into the air around the leaf', 30, 45),
    { id: 's1', speaker: 'student' as const, text: 'Where does the food go?', start: 50, end: 52 },
  ];
  const metrics = computeSpeechMetrics(utterances, [20]);
  const evidence = buildEvidence({ initial, final: m, events, metrics, learning: learningSummary(initial, m) });
  const f = factsFrom({ levelId: 'middle', utterances, events, metrics, evidence, finalModel: m });
  assert.equal(f.undefinedTerms, 1);
  assert.equal(f.demonstrated, 1);
  assert.equal(f.conceptsExplained, 1);
  assert.equal(f.studentQuestions, 1);
  assert.ok(f.invitations >= 1);
  assert.equal(f.fillersPerMin, 0, '35s of timed speech, no fillers');
  assert.equal(factsFrom({ levelId: 'middle', utterances: utterances.slice(0, 1), events, metrics: computeSpeechMetrics(utterances.slice(0, 1)), evidence, finalModel: m }).fillersPerMin, null, 'under 30s of speech -> fillers not rated');
  const s = scoreSession({ levelId: 'middle', utterances, events, metrics, evidence, finalModel: m });
  assert.equal(s.communication.score, 3, '4 - 1 undefined term');
  assert.ok(s.communication.evidenceIds.length >= 1, 'explanation is backed by evidence ids');
  assert.equal(s.teaching.score, 5, '3 + demonstrated + example; cap lifted by the demonstration');
});

test('missing data never throws', () => {
  const s = scoreSession({ levelId: 'high', utterances: [], events: [], metrics: null, evidence: [], finalModel: null });
  assert.equal(s.engagement.score, null);
  assert.equal(s.teaching.score, null);
});
