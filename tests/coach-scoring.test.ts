import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreEngagement, scoreCommunication, scoreTeaching, scoreSession, scoresFromFacts, factsFrom, weaknesses, overallScore,
  CRITERIA, CATEGORIES, OVERALL_WEIGHTS, type SessionFacts,
} from '../lib/coach/rubric.ts';
import { initStudentModel, applyEvaluation, applyVerification, learningSummary } from '../lib/student/knowledge.ts';
import { recordQuestion } from '../lib/student/questions.ts';
import { computeSpeechMetrics } from '../lib/student/speech.ts';
import { buildEvidence } from '../lib/student/evidence.ts';
import { isKnownTerm } from '../lib/levels.ts';
import { EXTRACTION, seg, proposal, goodC1 } from './fixtures.ts';
import type { Segment } from '../lib/student/types.ts';

export const base = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  levelId: 'middle', teacherWords: 200, teacherSpeakingSec: 90, studentTurns: 2, invitations: 0, studentQuestions: 0,
  answered: 0, partlyAnswered: 0, longRuns: 0, undefinedTerms: 0, unclear: 0, incorrect: 0, accurate: 1, shallow: 0, reinforced: 0,
  conceptsTotal: 3, conceptsMentioned: 2, conceptsExplained: 1, orderedExplained: 0, orderable: 0, demonstrated: 0, partlyDemonstrated: 0,
  demoAttempts: 0, misconceptionsResolved: 0, misconceptionsVoiced: 0, misconceptionsLeftStanding: 0,
  examples: 0, wpm: null, fillersPerMin: null, maxRunSec: null, ...over,
});

test('rubric: weights sum to 100 in every category; overall weights sum to 1', () => {
  for (const c of CATEGORIES) assert.equal(CRITERIA.filter((x) => x.category === c).reduce((n, x) => n + x.weight, 0), 100, c);
  assert.equal(Object.values(OVERALL_WEIGHTS).reduce((a, b) => a + b, 0), 1);
});

test('too little speech -> "Not enough evidence" for every category and overall', () => {
  const s = scoresFromFacts(base({ teacherWords: 25 }), []);
  for (const c of CATEGORIES) {
    assert.equal(s[c].score, null);
    assert.match(s[c].explanation, /^Not enough evidence/);
  }
  assert.equal(s.overall, null);
});

test('scores are deterministic, 0-100, and meaningfully spread', () => {
  const strong = base({ invitations: 2, studentQuestions: 4, answered: 4, maxRunSec: 40, accurate: 3, conceptsExplained: 3, demonstrated: 2, orderable: 2, orderedExplained: 2, misconceptionsVoiced: 1, misconceptionsResolved: 1, wpm: 140, fillersPerMin: 2 });
  const weak = base({ invitations: 0, studentTurns: 0, studentQuestions: 4, answered: 0, longRuns: 1, maxRunSec: 120, accurate: 0, shallow: 2, incorrect: 2, unclear: 2, undefinedTerms: 3, conceptsExplained: 1, misconceptionsVoiced: 1, misconceptionsLeftStanding: 1, wpm: 240, fillersPerMin: 10 });
  const a = scoresFromFacts(strong, []);
  const b = scoresFromFacts(weak, []);
  assert.deepEqual(scoresFromFacts(strong, []), a, 'same input, same scores');
  for (const c of CATEGORIES) {
    assert.ok(a[c].score! >= 90, `${c} strong=${a[c].score}`);
    assert.ok(b[c].score! <= 40, `${c} weak=${b[c].score}`);
    assert.ok(a[c].score! <= 100 && b[c].score! >= 0);
  }
  assert.equal(a.engagement.score, 100);
  assert.ok(a.overall! - b.overall! >= 60, `overall spread ${a.overall} vs ${b.overall}`);
});

test('overall = weighted combination of the rated categories', () => {
  assert.equal(overallScore({ engagement: { score: 50 }, communication: { score: 80 }, teaching: { score: 90 } }), Math.round(0.3 * 50 + 0.3 * 80 + 0.4 * 90));
  assert.equal(overallScore({ engagement: { score: 60 }, communication: { score: null }, teaching: { score: 80 } }), Math.round((0.3 * 60 + 0.4 * 80) / 0.7), 'renormalized over rated categories');
});

test('more check-ins or more talking is not rewarded beyond what a criterion needs', () => {
  assert.equal(scoreEngagement(base({ invitations: 2 }), []).score, scoreEngagement(base({ invitations: 10 }), []).score);
  assert.equal(scoreCommunication(base({ teacherWords: 150 }), []).score, scoreCommunication(base({ teacherWords: 900 }), []).score);
  assert.equal(scoreTeaching(base({ teacherWords: 150 }), []).score, scoreTeaching(base({ teacherWords: 900 }), []).score, 'concise explanations score the same as long ones');
});

test('pace and fillers only count when measured; pauses never count', () => {
  const unmeasured = scoreCommunication(base(), []);
  const fine = scoreCommunication(base({ wpm: 140, fillersPerMin: 3 }), []);
  const fast = scoreCommunication(base({ wpm: 240, fillersPerMin: 3 }), []);
  assert.equal(unmeasured.criteria.find((c) => c.id === 'C4')!.value, null);
  assert.equal(unmeasured.score, 100);
  assert.equal(fine.score, 100);
  assert.ok(fast.score! < fine.score!);
  assert.ok(!('longPauses' in base()), 'no pause input exists');
});

test('unexplained basic terms barely matter; factual errors and shallow explanations cost more', () => {
  const clean = scoresFromFacts(base({ accurate: 2, conceptsExplained: 2 }), []);
  const oneTerm = scoresFromFacts(base({ accurate: 2, conceptsExplained: 2, undefinedTerms: 1 }), []);
  const oneError = scoresFromFacts(base({ accurate: 2, conceptsExplained: 2, incorrect: 1 }), []);
  const shallow = scoresFromFacts(base({ accurate: 1, shallow: 1, conceptsExplained: 2 }), []);
  const lostTerm = clean.overall! - oneTerm.overall!;
  const lostError = clean.overall! - oneError.overall!;
  const lostShallow = clean.overall! - shallow.overall!;
  assert.ok(lostTerm <= 3, `one unexplained term costs ${lostTerm}`);
  assert.ok(lostError > 2 * lostTerm, `an error (${lostError}) costs more than a term (${lostTerm})`);
  assert.ok(lostShallow > lostTerm, `a shallow explanation (${lostShallow}) costs more than a term (${lostTerm})`);
  // Code never flags age-appropriate vocabulary, whatever the model says.
  assert.ok(isKnownTerm('photosynthesis', 'high') && isKnownTerm('ATP', 'college') && !isKnownTerm('thylakoid', 'college'));
});

test('explaining is not learning: teaching needs the student to show it', () => {
  const noDemo = scoreTeaching(base({ accurate: 3, conceptsExplained: 3 }), []);
  const demo = scoreTeaching(base({ accurate: 3, conceptsExplained: 3, demonstrated: 1 }), []);
  assert.ok(demo.score! - noDemo.score! >= 15, `${noDemo.score} -> ${demo.score}`);
  assert.match(noDemo.explanation, /never showed it understood/);
});

test('explanation names the costliest criterion; weaknesses map to skills', () => {
  const s = scoresFromFacts(base({ longRuns: 1, maxRunSec: 120, undefinedTerms: 2, incorrect: 2 }), []);
  assert.match(s.teaching.explanation, /didn't match the material/);
  const w = weaknesses(s).map((x) => x.skill);
  assert.equal(w[0], 'accuracy', 'two factual errors are the biggest loss');
  assert.ok(w.includes('student_participation') && w.includes('building_understanding'));
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
  m = recordQuestion(r.model, { kind: 'question', type: 'clarify', conceptId: 'c1', misconceptionId: null, followsQuestionId: null, focus: null, reason: '', score: 1 }, 'Where does the food go?', 50);
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
  assert.equal(f.accurate, 1);
  assert.equal(f.demonstrated, 1);
  assert.equal(f.conceptsExplained, 1);
  assert.equal(f.conceptsTotal, 3);
  assert.equal(f.studentQuestions, 1);
  assert.ok(f.invitations >= 1);
  assert.equal(f.fillersPerMin, 0, '35s of timed speech, no fillers');
  const s = scoreSession({ levelId: 'middle', utterances, events, metrics, evidence, finalModel: m });
  assert.equal(s.scale, 100);
  assert.equal(s.communication.criteria.find((c) => c.id === 'C2')!.value, 0.8, 'one term beyond a middle schooler');
  assert.ok(s.communication.evidenceIds.length >= 1, 'backed by evidence ids');
  assert.ok(s.overall !== null && s.overall > 0 && s.overall <= 100);
});

test('missing data never throws', () => {
  const s = scoreSession({ levelId: 'high', utterances: [], events: [], metrics: null, evidence: [], finalModel: null });
  assert.equal(s.engagement.score, null);
  assert.equal(s.teaching.score, null);
  assert.equal(s.overall, null);
});
