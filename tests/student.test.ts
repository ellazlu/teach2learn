import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION, seg, proposal, GOOD_C1_TEXT, goodC1 } from './fixtures.ts';
import { initStudentModel, applyEvaluation, sanitizeExtraction, learningSummary } from '../lib/student/knowledge.ts';
import { CAP_ACTIVE } from '../lib/student/misconceptions.ts';
import { selectQuestion, scoreCandidates, recordQuestion, seededRng } from '../lib/student/questions.ts';
import { behaviorFromEvents, transition, decideAction } from '../lib/student/behavior.ts';
import { isLikelyEcho, addFinal, emptyBuffer, shouldFlush, bufferToSegment, mergeSegments } from '../lib/student/segments.ts';
import type { StudentModel } from '../lib/student/types.ts';

const mastery = (m: StudentModel, id: string) => m.concepts.find((c) => c.id === id)!.mastery;
const mis = (m: StudentModel, id: string) => m.misconceptions.find((x) => x.id === id)!;

// ---- Initial knowledge ---------------------------------------------------------

test('initial knowledge differs across student levels', () => {
  const k = initStudentModel(EXTRACTION, 'kindergarten');
  const c = initStudentModel(EXTRACTION, 'college');
  const e = initStudentModel(EXTRACTION, 'expert');
  for (const id of ['c1', 'c2', 'c3']) {
    assert.ok(mastery(k, id) < mastery(c, id), `${id}: kindergarten < college`);
  }
  assert.ok(mastery(c, 'c3') < mastery(e, 'c3'));
  assert.ok(k.misconceptions.length >= e.misconceptions.length, 'beginners start with at least as many misconceptions');
  assert.ok(k.concepts.length <= 3, 'short sessions focus on 1-3 concepts');
});

test('initial mastery depends on difficulty and prerequisites, not one flat number', () => {
  const m = initStudentModel(EXTRACTION, 'high');
  const values = m.concepts.map((c) => c.mastery);
  assert.ok(new Set(values).size > 1, `expected varied mastery, got ${values}`);
  assert.ok(mastery(m, 'c1') > mastery(m, 'c3'), 'easy concept starts higher than hard one with prerequisites');
});

test('sanitizeExtraction drops unknown, self and cyclic prerequisites', () => {
  const x = sanitizeExtraction(
    {
      concepts: [
        { id: 'A', name: 'a', description: '', difficulty: 9, prerequisites: ['b', 'a'], keyTerms: [] },
        { id: 'b', name: 'b', description: '', difficulty: 0, prerequisites: ['a', 'zzz'], keyTerms: [] },
      ],
      misconceptions: [{ id: 'm', conceptId: 'nope', belief: 'x', correction: 'y' }],
    },
    true
  );
  assert.deepEqual(x.concepts[0].prerequisites, []);
  assert.deepEqual(x.concepts[1].prerequisites, ['a']);
  assert.equal(x.concepts[0].difficulty, 5);
  assert.equal(x.concepts[1].difficulty, 1);
  assert.equal(x.misconceptions.length, 0);
});

// ---- Knowledge updates -----------------------------------------------------------

test('a good explanation increases mastery, gradually', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  // Resolve the soil misconception first so the cap doesn't interfere.
  m0.misconceptions = m0.misconceptions.filter((m) => m.conceptId !== 'c1');
  const r1 = applyEvaluation(m0, seg(GOOD_C1_TEXT), goodC1);
  const g1 = mastery(r1.model, 'c1') - mastery(m0, 'c1');
  assert.ok(g1 >= 8, `gain ${g1}`);
  assert.ok(g1 <= 45, 'no huge jump from one explanation');
  const r2 = applyEvaluation(r1.model, seg(GOOD_C1_TEXT), goodC1);
  const g2 = mastery(r2.model, 'c1') - mastery(r1.model, 'c1');
  assert.ok(g2 > 0 && g2 < g1, `diminishing returns: ${g1} then ${g2}`);
  assert.ok(r1.events.some((e) => e.type === 'mastery_change'));
});

test('mentioning a concept does not increase mastery', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  const text = 'later we will talk about the light dependent reactions';
  const r = applyEvaluation(m0, seg(text), proposal({ concepts: [{ concept_id: 'c3', explained: false, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'the light dependent reactions' }] }));
  assert.equal(mastery(r.model, 'c3'), mastery(m0, 'c3'));
  assert.equal(r.model.concepts.find((c) => c.id === 'c3')!.mentioned, true);
  assert.ok(r.events.some((e) => e.type === 'mentioned_only'));
});

test('an incorrect explanation does not increase mastery (it can lower it)', () => {
  const m0 = initStudentModel(EXTRACTION, 'college');
  const text = 'chlorophyll absorbs green light which is why leaves look green';
  const r = applyEvaluation(m0, seg(text), proposal({ concepts: [{ concept_id: 'c2', explained: true, correctness: 'incorrect', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'chlorophyll absorbs green light' }] }));
  assert.ok(mastery(r.model, 'c2') <= mastery(m0, 'c2'));
  assert.ok(r.events.some((e) => e.type === 'incorrect_explanation'));
});

test('an unclear or too-advanced explanation helps far less than a clear one', () => {
  const base = initStudentModel(EXTRACTION, 'kindergarten');
  base.misconceptions = [];
  const text = 'the photolysis of water in photosystem two releases oxygen and drives ATP synthesis';
  const p = (fit: 'appropriate' | 'too_advanced', clarity: 'clear' | 'unclear') =>
    proposal({ concepts: [{ concept_id: 'c3', explained: true, correctness: 'correct', clarity, level_fit: fit, used_example: false, quote: 'photolysis of water in photosystem two releases oxygen' }] });
  const good = mastery(applyEvaluation(base, seg(text), p('appropriate', 'clear')).model, 'c3') - mastery(base, 'c3');
  const advanced = mastery(applyEvaluation(base, seg(text), p('too_advanced', 'clear')).model, 'c3') - mastery(base, 'c3');
  const unclear = mastery(applyEvaluation(base, seg(text), p('appropriate', 'unclear')).model, 'c3') - mastery(base, 'c3');
  assert.ok(advanced < good / 2, `too advanced ${advanced} vs ${good}`);
  assert.ok(unclear < good / 2, `unclear ${unclear} vs ${good}`);
});

test('weak prerequisites slow learning of a dependent concept', () => {
  const m = initStudentModel(EXTRACTION, 'high');
  m.misconceptions = [];
  const text = 'in the light reactions water is split and the energy makes atp and nadph';
  const p = proposal({ concepts: [{ concept_id: 'c3', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'water is split and the energy makes atp' }] });
  const weak = mastery(applyEvaluation(m, seg(text), p).model, 'c3') - mastery(m, 'c3');
  const strong = structuredClone(m);
  strong.concepts.filter((c) => c.id !== 'c3').forEach((c) => (c.mastery = 80));
  const s = mastery(applyEvaluation(strong, seg(text), p).model, 'c3') - mastery(strong, 'c3');
  assert.ok(s > weak, `strong prereq ${s} > weak prereq ${weak}`);
});

test('proposals whose quote is not in the segment are rejected', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  m0.misconceptions = [];
  const r = applyEvaluation(m0, seg('um so today we are talking about plants'), goodC1);
  assert.equal(mastery(r.model, 'c1'), mastery(m0, 'c1'));
  assert.ok(r.events.some((e) => e.type === 'rejected_proposal'));
});

// ---- Misconceptions --------------------------------------------------------------

test('misconceptions persist when the concept is merely mentioned or explained', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  assert.equal(mis(m0, 'm1').status, 'active');
  const r = applyEvaluation(m0, seg(GOOD_C1_TEXT), goodC1); // explains c1 but never addresses the soil idea
  assert.equal(mis(r.model, 'm1').status, 'active');
  assert.ok(mastery(r.model, 'c1') <= CAP_ACTIVE, 'mastery is capped while the misconception stands');
});

test('partial correction leaves the student partly confused; a full correction resolves it', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  const t1 = 'plants do get some stuff from the soil but not really food';
  const r1 = applyEvaluation(m0, seg(t1), proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'partially_corrected', quote: 'not really food' }] }));
  assert.equal(mis(r1.model, 'm1').status, 'partially_addressed');
  const t2 = 'the soil gives water and minerals but the food itself the sugar is made in the leaves from sunlight';
  const r2 = applyEvaluation(r1.model, seg(t2), proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the sugar is made in the leaves from sunlight' }] }));
  assert.equal(mis(r2.model, 'm1').status, 'resolved');
  assert.equal(mis(r2.model, 'm1').history.length, 2);
});

test('a reinforced misconception becomes active again', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  const r1 = applyEvaluation(m0, seg('the food is made in the leaves from sunlight'), proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the food is made in the leaves' }] }));
  const r2 = applyEvaluation(r1.model, seg('roots suck food up from the dirt'), proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'reinforced', quote: 'roots suck food up from the dirt' }] }));
  assert.equal(mis(r2.model, 'm1').status, 'active');
});

// ---- Robustness ----------------------------------------------------------------------

test('repeated transcript segments do not produce duplicate updates', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  m0.misconceptions = [];
  const s = seg(GOOD_C1_TEXT);
  const r1 = applyEvaluation(m0, s, goodC1);
  const r2 = applyEvaluation(r1.model, s, goodC1);
  assert.equal(r2.model, r1.model, 'same object returned: no change');
  assert.equal(r2.events.length, 0);
});

test('student speech is never processed as teacher speech', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  const r = applyEvaluation(m0, seg(GOOD_C1_TEXT, 10, 'student'), goodC1);
  assert.equal(r.model, m0);
  assert.ok(isLikelyEcho('why do plants need sunlight', ['Why do plants need sunlight?']));
  assert.ok(isLikelyEcho('do plants need sunlight', ['Why do plants need sunlight?']));
  assert.ok(!isLikelyEcho('plants need sunlight to make sugar in their leaves', ['What is chlorophyll?']));
});

test('a missing API response does not corrupt state', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  const snapshot = JSON.stringify(m0);
  const r = applyEvaluation(m0, seg(GOOD_C1_TEXT), null);
  assert.equal(r.model, m0);
  assert.equal(JSON.stringify(m0), snapshot);
  // Garbage proposal shapes are ignored too.
  const r2 = applyEvaluation(m0, seg(GOOD_C1_TEXT), { concepts: [{ concept_id: 'nope' }], misconceptions: null } as never);
  assert.deepEqual(r2.model.concepts, m0.concepts);
});

test('knowledge stays consistent across many turns', () => {
  let m = initStudentModel(EXTRACTION, 'high');
  const before = JSON.stringify(m);
  for (let i = 0; i < 40; i++) {
    const r = applyEvaluation(m, seg(GOOD_C1_TEXT, i * 10), goodC1);
    for (const c of r.model.concepts) {
      assert.ok(c.mastery >= 0 && c.mastery <= 100 && Number.isInteger(c.mastery));
      assert.ok(c.confidence >= 0 && c.confidence <= 0.95);
    }
    const prev = mastery(m, 'c1');
    assert.ok(mastery(r.model, 'c1') >= prev, 'good explanations never lower mastery');
    m = r.model;
  }
  assert.equal(JSON.stringify(initStudentModel(EXTRACTION, 'high')), before, 'init is deterministic');
  assert.equal(m.processedSegmentIds.length, 40);
});

// ---- Question selection ---------------------------------------------------------------

const rng0 = () => 0;

test('prerequisite gaps influence question selection', () => {
  // A middle schooler doesn't yet know the earlier ideas this builds on.
  const m = initStudentModel(EXTRACTION, 'middle');
  m.misconceptions = [];
  const c3 = m.concepts.find((c) => c.id === 'c3')!;
  c3.mentioned = true;
  c3.explained = true;
  const plan = selectQuestion(m, { recentConceptIds: ['c3'], rng: rng0 });
  assert.ok(plan);
  assert.equal(plan!.type, 'prerequisite');
  assert.ok(['c1', 'c2'].includes(plan!.conceptId!), `asks about a missing prerequisite, got ${plan!.conceptId}`);
});

test('older students already know the basics a younger one would lack', () => {
  const kid = initStudentModel(EXTRACTION, 'middle');
  const hs = initStudentModel(EXTRACTION, 'high');
  const uni = initStudentModel(EXTRACTION, 'college');
  const c1 = (m: typeof kid) => m.concepts.find((c) => c.id === 'c1')!.initialMastery;
  assert.ok(c1(kid) < c1(hs) && c1(hs) < c1(uni));
  assert.ok(c1(hs) >= 35, 'a high schooler is not missing an elementary prerequisite');
  const m = structuredClone(hs);
  m.misconceptions = [];
  const c3 = m.concepts.find((c) => c.id === 'c3')!;
  c3.mentioned = true;
  c3.explained = true;
  const plan = selectQuestion(m, { recentConceptIds: ['c3'], rng: rng0 });
  assert.ok(!plan || plan.conceptId !== 'c1', 'no "what is photosynthesis?" from a high schooler');
});

test('mentioned-but-unexplained concepts prompt a beginner to ask what it means', () => {
  const m = initStudentModel(EXTRACTION, 'kindergarten');
  m.misconceptions = [];
  m.concepts.find((c) => c.id === 'c2')!.mentioned = true;
  const plan = selectQuestion(m, { recentConceptIds: ['c2'], rng: rng0 });
  assert.equal(plan?.type, 'define_term');
  assert.equal(plan?.conceptId, 'c2');
});

test('unresolved misconceptions drive questions about the concept being taught', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  Object.assign(m.concepts.find((c) => c.id === 'c1')!, { mentioned: true, explained: true });
  const plan = selectQuestion(m, { recentConceptIds: ['c1'], rng: rng0 });
  assert.equal(plan?.type, 'misconception');
  assert.equal(plan?.misconceptionId, 'm1');
});

test('previously answered questions are not repeated', () => {
  let m = initStudentModel(EXTRACTION, 'middle');
  Object.assign(m.concepts.find((c) => c.id === 'c1')!, { mentioned: true, explained: true });
  const plan = selectQuestion(m, { recentConceptIds: ['c1'], rng: rng0 })!;
  assert.equal(plan.type, 'misconception');
  m = recordQuestion(m, plan, 'Don\'t plants eat dirt?', 20);
  m.questions[0].status = 'answered';
  const again = scoreCandidates(m, { recentConceptIds: ['c1'], rng: rng0 });
  assert.ok(!again.some((c) => c.type === plan.type && c.misconceptionId === plan.misconceptionId && c.conceptId === plan.conceptId));
  assert.equal(m.misconceptions.find((x) => x.id === 'm1')!.expressed, true);
});

test('a partly answered question gets a follow-up', () => {
  let m = initStudentModel(EXTRACTION, 'college');
  m.misconceptions = [];
  m = recordQuestion(m, { kind: 'question', type: 'clarify', conceptId: 'c2', misconceptionId: null, followsQuestionId: null, reason: '', score: 1 }, 'What is chlorophyll exactly?', 30);
  m.questions[0].status = 'partially_answered';
  const plan = selectQuestion(m, { recentConceptIds: [], rng: rng0 });
  assert.equal(plan?.type, 'follow_up');
  assert.equal(plan?.followsQuestionId, 'q1');
});

test('nothing worth asking means no question', () => {
  const m = initStudentModel(EXTRACTION, 'expert');
  m.misconceptions = [];
  assert.equal(selectQuestion(m, { recentConceptIds: [], rng: rng0 }), null);
});

test('question choice is reproducible with a seeded rng', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  m.concepts.forEach((c) => (c.mentioned = true));
  const a = scoreCandidates(m, { recentConceptIds: ['c2'], rng: seededRng(7) });
  const b = scoreCandidates(m, { recentConceptIds: ['c2'], rng: seededRng(7) });
  assert.deepEqual(a, b);
});

// ---- Behavior ---------------------------------------------------------------------------

test('behavior follows the evaluation, with level-specific reactions', () => {
  const kid = initStudentModel(EXTRACTION, 'kindergarten');
  const ev = [{ type: 'undefined_term' as const, segmentId: 's', at: 1, term: 'NADPH', quote: 'NADPH' }];
  assert.equal(behaviorFromEvents(kid, ev), 'confused');
  const expert = initStudentModel(EXTRACTION, 'expert');
  assert.equal(behaviorFromEvents(expert, ev), 'listening', 'jargon does not confuse an expert');
  const unclear = [{ type: 'unclear_explanation' as const, segmentId: 's', at: 1, conceptId: 'c3', quote: 'x', levelFit: 'appropriate' as const }];
  assert.equal(behaviorFromEvents(expert, unclear), 'challenging');
  const gain = [{ type: 'mastery_change' as const, segmentId: 's', at: 1, conceptId: 'c1', from: 10, to: 22, quote: 'x', reason: '' }];
  assert.equal(behaviorFromEvents(kid, gain), 'understanding');
});

test('state transitions are never contradictory', () => {
  assert.equal(transition('confused', 'understanding', { speaking: true, now: 10, since: 0 }), 'responding');
  assert.equal(transition('responding', 'confused', { speaking: false, now: 10, since: 0 }), 'listening', 'must return to listening after speaking');
  assert.equal(transition('confused', 'understanding', { speaking: false, now: 10, since: 9 }), 'confused', 'mild change waits out the dwell time');
  assert.equal(transition('understanding', 'confused', { speaking: false, now: 10, since: 9 }), 'confused', 'confusion can interrupt');
});

test('the policy never interrupts while speaking, during cooldown, or while waiting for an answer', () => {
  let m = initStudentModel(EXTRACTION, 'middle');
  m.concepts.find((c) => c.id === 'c1')!.mentioned = true;
  const base = { model: m, events: [], now: 100, lastInterjectionAt: -Infinity, speaking: false, finishing: false, teacherRunSec: 10, recentConceptIds: ['c1'], understandingShown: [], rng: rng0 };
  assert.equal(decideAction(base).kind, 'question');
  assert.equal(decideAction({ ...base, speaking: true }).kind, 'none');
  assert.equal(decideAction({ ...base, lastInterjectionAt: 95 }).kind, 'none');
  m = recordQuestion(m, decideAction(base) as never, 'Do plants eat dirt?', 90);
  assert.deepEqual(decideAction({ ...base, model: m }), { kind: 'none', reason: 'waiting for an answer' });
});

test('the student shows understanding after a clear explanation', () => {
  const m = initStudentModel(EXTRACTION, 'expert');
  m.misconceptions = [];
  m.behavior = 'understanding';
  const events = [{ type: 'mastery_change' as const, segmentId: 's', at: 1, conceptId: 'c2', from: 50, to: 62, quote: 'x', reason: '' }];
  const a = decideAction({ model: m, events, now: 100, lastInterjectionAt: -Infinity, speaking: false, finishing: false, teacherRunSec: 10, recentConceptIds: [], understandingShown: [], rng: rng0 });
  assert.equal(a.kind, 'show_understanding');
  const b = decideAction({ model: m, events, now: 100, lastInterjectionAt: -Infinity, speaking: false, finishing: false, teacherRunSec: 10, recentConceptIds: [], understandingShown: ['c2'], rng: rng0 });
  assert.notEqual(b.kind, 'show_understanding');
});

// ---- Segments & summary --------------------------------------------------------------------

test('segments only flush on settled speech', () => {
  let b = emptyBuffer();
  b = addFinal(b, 'plants make food', 1, 2);
  assert.equal(shouldFlush(b, 3), null, 'too few words, no pause yet');
  b = addFinal(b, 'from sunlight and water every day', 2, 4);
  assert.equal(shouldFlush(b, 5), null);
  assert.equal(shouldFlush(b, 7), 'pause');
  const s = bufferToSegment(b, 'x')!;
  assert.equal(s.start, 1);
  assert.equal(s.end, 4);
  const merged = mergeSegments([s, { ...s, id: 'y', start: 10, end: 12 }])!;
  assert.equal(merged.id, 'x+y');
  assert.equal(merged.end, 12);
});

test('learning summary reports what was learned, what is confusing, and misconception changes', () => {
  const m0 = initStudentModel(EXTRACTION, 'middle');
  let m = applyEvaluation(m0, seg('the food itself the sugar is made in the leaves from sunlight'), proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the sugar is made in the leaves from sunlight' }] })).model;
  m = applyEvaluation(m, seg(GOOD_C1_TEXT), goodC1).model;
  m = applyEvaluation(m, seg('chlorophyll is a thing'), proposal({ concepts: [{ concept_id: 'c2', explained: false, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'chlorophyll is a thing' }] })).model;
  const s = learningSummary(m0, m);
  assert.ok(s.learned.some((x) => x.conceptId === 'c1'));
  assert.ok(s.stillConfusing.some((x) => x.conceptId === 'c2'));
  assert.ok(s.notCovered.some((x) => x.conceptId === 'c3'));
  assert.equal(s.misconceptions.find((x) => x.id === 'm1')!.to, 'resolved');
});
