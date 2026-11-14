// The student should ask about the specific thing it's stuck on, not a vague
// "can you explain it another way?". Built around a real session where the
// student was confused about why gravity makes planets orbit, but asked a
// generic question about "the components of the solar system".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeExtraction, initStudentModel, applyEvaluation, learningSummary } from '../lib/student/knowledge.ts';
import { selectQuestion, scoreCandidates } from '../lib/student/questions.ts';
import { specificity, fallbackLine } from '../lib/student/dialogue.ts';
import { buildEvidence } from '../lib/student/evidence.ts';
import { computeSpeechMetrics } from '../lib/student/speech.ts';
import { proposal } from './fixtures.ts';
import type { Segment } from '../lib/student/types.ts';

const SOLAR = sanitizeExtraction(
  {
    topicTitle: 'The solar system',
    overview: '',
    concepts: [
      { id: 's1', name: 'Components of the solar system', description: 'The Sun, planets, moons, asteroids and comets.', difficulty: 1, prerequisites: [], keyTerms: ['planet', 'moon'] },
      { id: 's2', name: 'Gravity and orbits', description: "Gravity pulls planets toward the Sun while their sideways motion keeps them from falling in, so they orbit.", difficulty: 3, prerequisites: ['s1'], keyTerms: ['gravity', 'orbit'] },
    ],
    misconceptions: [],
  },
  false
);

const GAP = "If gravity pulls the planets in, why don't they fall into the Sun?";
let n = 0;
const seg = (text: string, start: number): Segment => ({ id: `g${++n}`, speaker: 'teacher', text, start, end: start + 6 });
const components = seg('the solar system has the sun eight planets their moons and lots of asteroids and comets', 5);
const gravity = seg('gravity is the force that pulls the planets toward the sun and that is what keeps them going around it', 20);

function confusedAboutGravity() {
  let m = initStudentModel(SOLAR, 'high');
  m = applyEvaluation(m, components, proposal({ concepts: [{ concept_id: 's1', explained: true, correctness: 'correct', clarity: 'somewhat_clear', level_fit: 'appropriate', used_example: false, quote: 'the sun eight planets their moons', gap: '' }] })).model;
  m = applyEvaluation(m, gravity, proposal({ concepts: [{ concept_id: 's2', explained: true, correctness: 'partially_correct', clarity: 'somewhat_clear', level_fit: 'appropriate', used_example: false, quote: 'pulls the planets toward the sun', gap: GAP }] })).model;
  return m;
}

test('an incomplete explanation records the specific question it leaves open', () => {
  const m = confusedAboutGravity();
  const g = m.concepts.find((c) => c.id === 's2')!.openGaps;
  assert.equal(g.length, 1);
  assert.equal(g[0].question, GAP);
  assert.equal(g[0].quote, 'pulls the planets toward the sun');
});

test('a clear, correct explanation closes the open question', () => {
  const m = confusedAboutGravity();
  const fix = seg("they don't fall in because they're also moving sideways really fast, so they keep falling around the sun instead of into it", 40);
  const r = applyEvaluation(m, fix, proposal({ concepts: [{ concept_id: 's2', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'moving sideways really fast', gap: '' }] }));
  assert.deepEqual(r.model.concepts.find((c) => c.id === 's2')!.openGaps, []);
});

test('mentioning the concept again does not close it', () => {
  const m = confusedAboutGravity();
  const r = applyEvaluation(m, seg('and gravity is really important for space', 40), proposal({ concepts: [{ concept_id: 's2', explained: false, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'gravity is really important', gap: '' }] }));
  assert.equal(r.model.concepts.find((c) => c.id === 's2')!.openGaps.length, 1);
});

test('the question targets the specific sticking point in the latest segment, not an older vague concept', () => {
  const m = confusedAboutGravity();
  const plan = selectQuestion(m, { recentConceptIds: ['s1', 's2'], latestConceptIds: ['s2'], rng: () => 0 });
  assert.equal(plan?.conceptId, 's2', 'asks about gravity, not "components of the solar system"');
  assert.equal(plan?.type, 'clarify');
  assert.equal(plan?.focus?.question, GAP);
  assert.match(plan!.reason, /stuck on/);
});

test('vague clarify questions without a target are penalized', () => {
  const m = confusedAboutGravity();
  m.concepts.find((c) => c.id === 's2')!.openGaps = [];
  const ranked = scoreCandidates(m, { recentConceptIds: ['s1', 's2'], latestConceptIds: ['s2'], rng: () => 0 });
  const vague = ranked.filter((c) => c.type === 'clarify' && !c.focus);
  const withGap = scoreCandidates(confusedAboutGravity(), { recentConceptIds: ['s1', 's2'], latestConceptIds: ['s2'], rng: () => 0 })[0];
  assert.ok(vague.every((v) => v.score < withGap.score));
});

test('the vague line from the real session is rejected; a targeted one passes', () => {
  const anchors = [GAP, 'pulls the planets toward the sun', 'Gravity and orbits', 'gravity', 'orbit'];
  const bad = "Sorry, I sort of get the components of the solar system, but I'm not quite there. Could you explain it another way?";
  assert.equal(specificity(bad, anchors).ok, false);
  assert.equal(specificity('Can you explain it another way?', anchors).ok, false);
  assert.equal(specificity("You said gravity pulls the planets toward the Sun, so why don't they crash into it?", anchors).ok, true);
  assert.equal(specificity('Wait, why does gravity keep them going around instead of pulling them in?', anchors).ok, true);
});

test('the fallback line is the specific question itself', () => {
  assert.equal(fallbackLine('clarify', { focusQuestion: GAP, conceptName: 'Gravity and orbits' }), GAP);
  assert.equal(fallbackLine('define_term', { term: 'orbit' }), 'What does "orbit" mean?');
  assert.equal(fallbackLine('misconception', { belief: 'Heavier objects fall faster.' }), 'Wait, but I thought heavier objects fall faster?');
});

test('open questions left at the end become timestamped feedback evidence', () => {
  const initial = initStudentModel(SOLAR, 'high');
  const final = confusedAboutGravity();
  const ev = buildEvidence({ initial, final, events: [], metrics: computeSpeechMetrics([]), learning: learningSummary(initial, final) });
  const open = ev.find((e) => e.kind === 'open_question')!;
  assert.equal(open.at, 20);
  assert.match(open.label, /why don't they fall into the Sun/);
});
