import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initStudentModel, applyEvaluation } from '../lib/student/knowledge.ts';
import { recordQuestion, seededRng } from '../lib/student/questions.ts';
import { cleanStudyExtraction, toChecklist, applyChecklist, addItem, moveItem, removeItem, renameItem, checklistProblems, TARGET } from '../lib/learner/checklist.ts';
import { initLearner, applyLearnerEvaluation, recordProbe, coverageOf, understandingOf, applyBoard } from '../lib/learner/tracker.ts';
import { selectProbe, decideLearnerTurn, scoreProbes } from '../lib/learner/probes.ts';
import { buildStudyEvidence, fallbackStudyFeedback, reviewCandidates, validateStudyFeedback } from '../lib/learner/feedback.ts';
import { shouldAnalyze, cleanBoard, boardSegmentText } from '../lib/learner/whiteboard.ts';
import type { Extraction, QuestionPlan } from '../lib/student/types.ts';
import { seg, proposal } from './fixtures.ts';

// A 6-concept checklist, prerequisites first.
const RAW = {
  topicTitle: 'Photosynthesis',
  overview: 'How plants make food.',
  concepts: [
    { id: 'c1', name: 'What photosynthesis is.', description: 'Plants make sugar from light, water and CO2.', difficulty: 1, prerequisites: [], keyTerms: ['photosynthesis'] },
    { id: 'c2', name: 'Chlorophyll', description: 'Pigment absorbing red and blue light.', difficulty: 2, prerequisites: ['c1'], keyTerms: ['chlorophyll'] },
    { id: 'c3', name: 'Light-dependent reactions', description: 'Split water, release O2, make ATP and NADPH.', difficulty: 4, prerequisites: ['c2'], keyTerms: ['ATP'] },
    { id: 'c4', name: 'Calvin cycle', description: 'Uses ATP and NADPH to fix CO2 into sugar.', difficulty: 4, prerequisites: ['c3'], keyTerms: ['Calvin cycle'] },
    { id: 'c5', name: 'Where the oxygen comes from', description: 'O2 comes from splitting water.', difficulty: 3, prerequisites: ['c3'], keyTerms: ['oxygen'] },
    { id: 'c6', name: 'Limiting factors', description: 'Light, CO2 and temperature limit the rate.', difficulty: 3, prerequisites: ['c1'], keyTerms: ['limiting factor'] },
    { id: 'c7', name: 'C4 plants', description: 'x', difficulty: 5, prerequisites: [], keyTerms: [] },
    { id: 'c8', name: 'CAM plants', description: 'x', difficulty: 5, prerequisites: [], keyTerms: [] },
    { id: 'c9', name: 'Stomata', description: 'x', difficulty: 2, prerequisites: [], keyTerms: [] },
    { id: 'c10', name: 'Glucose uses', description: 'x', difficulty: 2, prerequisites: [], keyTerms: [] },
    { id: 'c11', name: 'Too many', description: 'x', difficulty: 2, prerequisites: [], keyTerms: [] },
  ],
  misconceptions: [{ id: 'm1', conceptId: 'c5', belief: 'The oxygen comes from carbon dioxide.', correction: 'It comes from water.' }],
};

const EXT: Extraction = (() => {
  const e = cleanStudyExtraction(RAW as any, true);
  return applyChecklist(e, toChecklist(e).slice(0, 6));
})();

test('checklist: 5-10 short names, prerequisites only point backwards', () => {
  const e = cleanStudyExtraction(RAW as any, true);
  assert.equal(e.concepts.length, TARGET.max, 'capped at 10');
  assert.equal(e.concepts[0].name, 'What photosynthesis is', 'trailing punctuation trimmed');
  assert.ok(e.concepts.every((c, i) => c.prerequisites.every((p) => e.concepts.slice(0, i).some((x) => x.id === p))));
});

test('checklist editing: rename, add, remove, reorder; prerequisites and misconceptions follow', () => {
  let items = toChecklist(EXT);
  items = renameItem(items, 'c2', 'Chlorophyll and light');
  items = addItem(items, 'Leaf structure');
  items = addItem(items, 'leaf structure'); // duplicate ignored
  items = removeItem(items, 'c5');
  items = moveItem(items, 'c3', -1); // c3 before c2 now
  assert.deepEqual(items.map((i) => i.id), ['c1', 'c3', 'c2', 'c4', 'c6', 'u1']);
  assert.deepEqual(checklistProblems(items), []);
  const e = applyChecklist(EXT, items);
  const c3 = e.concepts.find((c) => c.id === 'c3')!;
  assert.deepEqual(c3.prerequisites, [], 'c2 is now later, so the link is dropped');
  assert.ok(e.concepts.find((c) => c.id === 'c2')!.keyTerms.includes('Chlorophyll and light'), 'renamed term is recognized in speech');
  assert.equal(e.misconceptions.length, 0, 'misconception about a removed concept dropped');
  const added = e.concepts.find((c) => c.id === 'u1')!;
  assert.match(added.description, /Added by the learner/);
  assert.deepEqual(checklistProblems([]), ['Add at least one concept.']);
});

// ---- Tracking -----------------------------------------------------------------------

const plan = (conceptId: string, type: QuestionPlan['type']): QuestionPlan => ({ kind: 'question', type, conceptId, misconceptionId: null, followsQuestionId: null, focus: null, reason: '', score: 1 });

function session() {
  let model = initStudentModel(EXT, 'high');
  let l = initLearner(EXT);
  const step = (text: string, p: ReturnType<typeof proposal>, at = 10) => {
    const s = seg(text, at);
    const r = applyEvaluation(model, s, p);
    model = r.model;
    l = applyLearnerEvaluation(l, s, p, model);
  };
  const ask = (conceptId: string, type: QuestionPlan['type'], text: string, at: number) => {
    model = recordQuestion(model, plan(conceptId, type), text, at);
    l = recordProbe(l, plan(conceptId, type), model.questions[model.questions.length - 1].id, text, at);
  };
  return { step, ask, get l() { return l; }, get model() { return model; } };
}

const explain = (id: string, quote: string, correctness: 'correct' | 'partially_correct' | 'incorrect' = 'correct', gap = '') =>
  proposal({ concepts: [{ concept_id: id, explained: true, correctness, clarity: 'clear', level_fit: 'appropriate', used_example: false, quote, gap }] });

test('mentioning is not understanding; explaining alone is Discussed, not Demonstrated', () => {
  const s = session();
  s.step('so there is something called chlorophyll in leaves', proposal({ concepts: [{ concept_id: 'c2', explained: false, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'something called chlorophyll in leaves', gap: '' }] }));
  const c2 = s.l.concepts.find((c) => c.id === 'c2')!;
  assert.equal(c2.coverage, 'discussed');
  assert.equal(understandingOf(c2), 'not_verified');
  s.step('photosynthesis is how plants make sugar from light water and carbon dioxide', explain('c1', 'plants make sugar from light water and carbon dioxide'));
  const c1 = s.l.concepts.find((c) => c.id === 'c1')!;
  assert.equal(c1.coverage, 'discussed', 'accurate explanation, but no follow-up handled yet');
  assert.equal(understandingOf(c1), 'partial');
  assert.equal(c1.depth, 1, 'clear accurate explanation moves past basics');
});

test('Demonstrated = accurate explanation + a follow-up answered fully and correctly', () => {
  const s = session();
  s.step('photosynthesis is how plants make sugar from light water and carbon dioxide', explain('c1', 'plants make sugar from light water and carbon dioxide'), 10);
  s.ask('c1', 'reasoning', 'Why do they need the light though?', 20);
  s.step('the light gives the energy to build the sugar molecules from the simpler ones', proposal({
    concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'the light gives the energy to build the sugar', gap: '' }],
    question_response: { quality: 'full', quote: 'the light gives the energy to build the sugar' },
  }), 25);
  const c1 = s.l.concepts.find((c) => c.id === 'c1')!;
  assert.equal(c1.probes[0].answer, 'full');
  assert.equal(c1.probes[0].correct, true);
  assert.equal(c1.coverage, 'demonstrated');
  assert.equal(c1.depth, 2, 'answered well -> next question goes deeper');
});

test('an error blocks Demonstrated until corrected; agreeing with a wrong idea is an error', () => {
  const s = session();
  s.step('the oxygen plants release comes from the carbon dioxide they take in', explain('c5', 'the oxygen plants release comes from the carbon dioxide', 'incorrect'), 10);
  let c5 = s.l.concepts.find((c) => c.id === 'c5')!;
  assert.equal(c5.errors.length, 1);
  assert.equal(understandingOf(c5), 'not_verified');
  assert.equal(c5.depth, 0);
  s.step('actually wait, the oxygen comes from splitting the water molecules', explain('c5', 'the oxygen comes from splitting the water molecules'), 30);
  c5 = s.l.concepts.find((c) => c.id === 'c5')!;
  assert.equal(c5.errors[0].corrected, true);
  assert.match(c5.errors[0].correctedQuote, /splitting the water/);
  // Endorsing the student's misconception.
  const t = session();
  t.step('yeah exactly the oxygen does come from the carbon dioxide', proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'reinforced', quote: 'the oxygen does come from the carbon dioxide' }] }));
  assert.equal(t.l.concepts.find((c) => c.id === 'c5')!.errors[0].kind, 'endorsed_misconception');
});

test('a wrong answer to a follow-up lowers the depth and counts against it', () => {
  const s = session();
  s.step('photosynthesis is how plants make sugar from light water and carbon dioxide', explain('c1', 'plants make sugar from light water and carbon dioxide'));
  s.ask('c1', 'reasoning', 'Why do they need light?', 20);
  s.step('they need light because it keeps the leaves warm enough to work', proposal({
    concepts: [{ concept_id: 'c1', explained: true, correctness: 'incorrect', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'it keeps the leaves warm enough', gap: '' }],
    question_response: { quality: 'full', quote: 'it keeps the leaves warm enough to work' },
  }), 25);
  const c1 = s.l.concepts.find((c) => c.id === 'c1')!;
  assert.equal(c1.probes[0].correct, false);
  assert.equal(c1.depth, 0);
  assert.notEqual(c1.coverage, 'demonstrated');
});

test('whiteboard content is evidence like speech (but the gate prevents spam)', () => {
  const s = session();
  const a = cleanBoard({ transcription: '6CO2 + 6H2O -> C6H12O6 + 6O2', description: 'an arrow from the sun to a leaf', concept_ids: ['c1', 'zzz'], unclear: [{ part: 'the word under the arrow', question: 'What did you write under the arrow?' }] }, { id: 'w1', at: 40, trigger: 'share', conceptIds: EXT.concepts.map((c) => c.id) });
  assert.deepEqual(a.conceptIds, ['c1'], 'unknown concept ids dropped');
  const text = boardSegmentText(a);
  assert.doesNotMatch(text, /under the arrow/, 'unclear parts are never judged');
  const bseg = { id: 'w1', speaker: 'teacher' as const, text, start: 40, end: 40, source: 'whiteboard' as const };
  const p = explain('c1', '6CO2 + 6H2O -> C6H12O6 + 6O2');
  const r = applyEvaluation(s.model, bseg, p);
  const l = applyLearnerEvaluation(initLearner(EXT), bseg, p, r.model);
  const c1 = l.concepts.find((c) => c.id === 'c1')!;
  assert.equal(c1.explanations[0].source, 'whiteboard');
  assert.equal(c1.whiteboard.length, 1);
  const lb = applyBoard(l, a);
  assert.equal(lb.board.pendingClarify!.question, 'What did you write under the arrow?');
  assert.ok(!shouldAnalyze({ trigger: 'pause', version: 3, analyzedVersion: 3, lastAutoAt: 0, now: 99999, blank: false, inFlight: false }), 'unchanged board');
  assert.ok(!shouldAnalyze({ trigger: 'pause', version: 4, analyzedVersion: 3, lastAutoAt: 1000, now: 5000, blank: false, inFlight: false }), 'too soon after last auto');
  assert.ok(shouldAnalyze({ trigger: 'share', version: 4, analyzedVersion: 3, lastAutoAt: 1000, now: 5000, blank: false, inFlight: false }), 'share is immediate');
  assert.ok(!shouldAnalyze({ trigger: 'share', version: 4, analyzedVersion: 3, lastAutoAt: 0, now: 5000, blank: true, inFlight: false }), 'blank board');
  assert.ok(!shouldAnalyze({ trigger: 'end', version: 4, analyzedVersion: 3, lastAutoAt: 0, now: 5000, blank: false, inFlight: true }), 'one request at a time');
  assert.equal(cleanBoard({ blank: true }, { id: 'w2', at: 1, trigger: 'pause', conceptIds: [] }).blank, true);
});

// ---- Probes -----------------------------------------------------------------------------

const rng = () => 0;

test('probes go deeper as answers improve, and errors are questioned (not corrected)', () => {
  const s = session();
  s.step('photosynthesis is how plants make sugar from light water and carbon dioxide', explain('c1', 'plants make sugar from light water and carbon dioxide'));
  let p = selectProbe(s.l, s.model, { recentConceptIds: ['c1'], latestConceptIds: ['c1'], rng })!;
  assert.equal(p.type, 'reasoning', 'depth 1 -> why/how');
  s.ask('c1', 'reasoning', 'Why light?', 20);
  s.step('light provides the energy to build sugar molecules', proposal({ concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'light provides the energy to build sugar', gap: '' }], question_response: { quality: 'full', quote: 'light provides the energy to build sugar molecules' } }), 25);
  p = selectProbe(s.l, s.model, { recentConceptIds: ['c1'], latestConceptIds: ['c1'], rng })!;
  assert.ok(['relate', 'assumption', 'apply_new', 'curiosity'].includes(p.type), `stretch or move on, got ${p.type}`);
  s.step('the oxygen comes from the carbon dioxide molecules', explain('c5', 'the oxygen comes from the carbon dioxide', 'incorrect'), 40);
  p = selectProbe(s.l, s.model, { recentConceptIds: ['c5'], latestConceptIds: ['c5'], rng })!;
  assert.equal(p.type, 'error_check');
  assert.match(p.focus!.quote, /carbon dioxide/);
});

test('omissions become specific questions; unclear drawings come first', () => {
  const s = session();
  s.step('chlorophyll is the green stuff that does something with light', explain('c2', 'chlorophyll is the green stuff', 'partially_correct', 'What does chlorophyll do with the light exactly?'));
  let p = selectProbe(s.l, s.model, { recentConceptIds: ['c2'], latestConceptIds: ['c2'], rng })!;
  assert.equal(p.type, 'clarify');
  assert.equal(p.focus!.question, 'What does chlorophyll do with the light exactly?');
  const l = applyBoard(s.l, cleanBoard({ transcription: 'x', description: 'a leaf', concept_ids: ['c2'], unclear: [{ part: 'the label on the left', question: 'Is that label "ATP" or "ADP"?' }] }, { id: 'w1', at: 50, trigger: 'share', conceptIds: ['c2'] }));
  p = selectProbe(l, s.model, { recentConceptIds: [], latestConceptIds: [], rng })!;
  assert.equal(p.type, 'board_clarify');
  const after = recordProbe(l, p, 'q9', 'Is that ATP or ADP?', 55);
  assert.equal(after.board.pendingClarify, null, 'asked once');
  assert.ok(!scoreProbes(after, s.model, { recentConceptIds: [], latestConceptIds: [], rng }).some((c) => c.type === 'board_clarify'));
});

test('turn decisions: check-ins get a probe, short turns get silence', () => {
  const s = session();
  s.step('photosynthesis is how plants make sugar from light water and carbon dioxide', explain('c1', 'plants make sugar from light water and carbon dioxide'));
  const base = { learner: s.l, model: s.model, now: 60, lastStudentAt: 0, lastStudentWasQuestion: false, recentConceptIds: ['c1'], rng: seededRng(1) };
  assert.equal(decideLearnerTurn({ ...base, turnText: 'so plants make sugar from light, does that make sense?' }).kind, 'ask');
  assert.equal(decideLearnerTurn({ ...base, turnText: 'um so' }).kind, 'none');
  assert.equal(decideLearnerTurn({ ...base, turnText: 'what do you think happens at night?' }).kind, 'answer');
  assert.equal(decideLearnerTurn({ ...base, lastStudentWasQuestion: true, turnText: 'because the light gives them energy to do it' }).kind, 'acknowledge');
});

// ---- Feedback ------------------------------------------------------------------------------

test('feedback: four content sections from evidence, no delivery metrics, valid citations only', () => {
  const s = session();
  s.step('photosynthesis is how plants make sugar from light water and carbon dioxide', explain('c1', 'plants make sugar from light water and carbon dioxide'), 10);
  s.step('the oxygen comes from the carbon dioxide molecules', explain('c5', 'the oxygen comes from the carbon dioxide', 'incorrect'), 30);
  const ev = buildStudyEvidence(s.l);
  const fb = fallbackStudyFeedback(s.l, ev, EXT);
  assert.match(fb.correct.text, /What photosynthesis is/);
  assert.match(fb.gaps.text, /Not covered/);
  assert.equal(fb.misconceptions.length, 1);
  assert.match(fb.misconceptions[0].quote, /carbon dioxide/);
  assert.equal(fb.reviewNext!.conceptId, 'c5', 'an uncorrected error is the top priority');
  assert.deepEqual(fb.concepts.map((c) => c.understanding), ['partial', 'not_verified', 'not_verified', 'not_verified', 'not_verified', 'not_verified']);
  const json = JSON.stringify(fb);
  assert.doesNotMatch(json, /engagement|professionalism|words per minute|filler|%/i);

  const cands = reviewCandidates(s.l, EXT);
  const errId = ev.find((e) => e.kind === 'error')!.id;
  const good = validateStudyFeedback({
    correct: { text: 'You explained what photosynthesis is accurately.', evidence_ids: [ev.find((e) => e.kind === 'accurate')!.id] },
    gaps: { text: 'You never got to chlorophyll or the reactions.', evidence_ids: [ev.find((e) => e.kind === 'not_covered')!.id] },
    misconceptions: [{ evidence_id: errId, what_was_off: 'The released oxygen comes from water, not CO2.' }, { evidence_id: 'S999', what_was_off: 'made up' }],
    review_next: { concept_id: 'c5', text: 'Revisit where the oxygen comes from.' },
  }, fb, ev, cands);
  assert.equal(good.usedFallback, false);
  assert.equal(good.misconceptions[0].note, 'The released oxygen comes from water, not CO2.');
  const bad = validateStudyFeedback({ correct: { text: 'Great job!', evidence_ids: ['S999'] }, gaps: { text: 'x', evidence_ids: [errId] }, review_next: { concept_id: 'c4', text: 'x' } }, fb, ev, cands);
  assert.equal(bad.correct.text, fb.correct.text, 'uncited praise rejected');
  assert.equal(bad.reviewNext!.conceptId, 'c5', 'review pick must be a top candidate');
  assert.equal(bad.usedFallback, true);
});

test('recurring gaps from earlier sessions raise review priority', () => {
  const s = session();
  const a = reviewCandidates(s.l, EXT)[0];
  const b = reviewCandidates(s.l, EXT, ['Limiting factors'])[0];
  assert.equal(a.conceptId, 'c1');
  assert.equal(b.conceptId, 'c6');
  assert.match(b.why, /earlier session/);
});

// ---- Two-stage checklist ---------------------------------------------------------------
import { outlineToExtraction, cleanDetails, mergeDetails, detailsReady } from '../lib/learner/checklist.ts';

test('two-stage checklist: names first, details merged by id even after edits', () => {
  const outline = outlineToExtraction({ topic_title: 'Photosynthesis', concepts: [
    { id: 'c1', name: 'What photosynthesis is', prerequisites: [] },
    { id: 'c2', name: 'Chlorophyll', prerequisites: ['c1'] },
    { id: 'c3', name: 'Where the oxygen comes from', prerequisites: ['c1', 'c9'] },
  ] }, false);
  assert.equal(detailsReady(outline), false);
  assert.deepEqual(outline.concepts[2].prerequisites, ['c1']);
  // The user edits while details load.
  let items = toChecklist(outline);
  items = renameItem(items, 'c2', 'Chlorophyll and light');
  items = addItem(items, 'Leaf structure');
  const details = cleanDetails({ overview: 'o', concepts: [
    { id: 'C1', description: 'Plants make sugar from light, water and CO2.', difficulty: 9, key_terms: ['photosynthesis'] },
    { id: 'c2', description: 'Absorbs red and blue light.', difficulty: 2, key_terms: ['chlorophyll'] },
    { id: 'zz', description: 'unknown concept', difficulty: 1, key_terms: [] },
  ], misconceptions: [{ id: 'm1', concept_id: 'c3', belief: 'Oxygen comes from CO2.', correction: 'From water.' }, { id: 'm2', concept_id: 'nope', belief: 'x', correction: 'y' }] }, ['c1', 'c2', 'c3']);
  assert.equal(details.concepts.length, 2, 'unknown ids dropped');
  assert.equal(details.concepts[0].difficulty, 5, 'clamped');
  assert.equal(details.misconceptions.length, 1);
  const merged = mergeDetails(outline, details);
  const final = applyChecklist(merged, items);
  assert.equal(final.concepts.find((c) => c.id === 'c2')!.description, 'Absorbs red and blue light.');
  assert.equal(final.concepts.find((c) => c.id === 'c2')!.name, 'Chlorophyll and light');
  assert.match(final.concepts.find((c) => c.id === 'c3')!.description, /Added by the learner|general|standard/, 'missing detail falls back to general knowledge');
  assert.match(final.concepts.find((c) => c.id === 'u1')!.description, /Added by the learner/);
  assert.equal(final.misconceptions[0].conceptId, 'c3');
  assert.ok(final.concepts.every((c) => c.description), 'never starts a session with an empty description');
});
