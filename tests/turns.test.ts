import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTeacherQuestion, matchConcepts, decideTurn, type TurnContext } from '../lib/student/turns.ts';
import { initStudentModel, applyVerification, conceptSummary, applyEvaluation } from '../lib/student/knowledge.ts';
import { takeSentences, flushSentences } from '../lib/student/sentences.ts';
import { knowledgeForPrompt } from '../lib/student/persona.ts';
import { scoreVoice } from '../lib/voice.js';
import { EXTRACTION, seg, proposal, GOOD_C1_TEXT, goodC1 } from './fixtures.ts';

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  model: initStudentModel(EXTRACTION, 'middle'),
  turnText: '',
  now: 20,
  timeLimitSec: 120,
  lastStudentAt: -Infinity,
  lastStudentWasQuestion: false,
  recentConceptIds: [],
  demoAttempts: {},
  rng: () => 0,
  ...over,
});

test('teacher questions are recognised at the end of a turn only', () => {
  assert.equal(detectTeacherQuestion('so plants make food from light does that make sense'), 'check');
  assert.equal(detectTeacherQuestion('okay do you understand'), 'check');
  assert.equal(detectTeacherQuestion('so what do you think happens to the oxygen'), 'content');
  assert.equal(detectTeacherQuestion('can you tell me what chlorophyll does'), 'content');
  assert.equal(detectTeacherQuestion('what is photosynthesis? well photosynthesis is how plants make sugar from light'), null, 'rhetorical question the teacher answered');
  assert.equal(detectTeacherQuestion('plants are green because chlorophyll reflects green light'), null);
});

test('concepts are matched instantly from the teacher\'s words', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  assert.deepEqual(matchConcepts('so the chlorophyll is what makes leaves green', m), ['c2']);
  assert.deepEqual(matchConcepts('plants make their own food from light and water', m), ['c1']);
  assert.deepEqual(matchConcepts('anyway let me think about this', m), []);
});

test('the student answers when asked, and explains back when asked if it understands', () => {
  const a = decideTurn(ctx({ turnText: 'so what do you think plants need to make food' }));
  assert.equal(a.kind, 'answer');
  const m = initStudentModel(EXTRACTION, 'middle');
  m.misconceptions = [];
  const taught = applyEvaluation(m, seg(GOOD_C1_TEXT), goodC1).model;
  const b = decideTurn(ctx({ model: taught, turnText: 'plants make their own food from light, does that make sense' }));
  assert.equal(b.kind, 'demonstrate');
  assert.equal((b as any).mode, 'explain_back');
});

test('the student lets the teacher continue after a short turn or within its cooldown', () => {
  assert.equal(decideTurn(ctx({ turnText: 'um so okay' })).kind, 'none');
  const m = initStudentModel(EXTRACTION, 'middle');
  m.misconceptions = [];
  const r = decideTurn(ctx({ model: m, turnText: 'plants make their own food from light and water and air', now: 20, lastStudentAt: 15 }));
  assert.equal(r.kind, 'none');
  assert.match(r.reason, /letting the teacher continue/);
});

test('after asking, the student reacts to the answer instead of asking something new', () => {
  const r = decideTurn(ctx({ turnText: 'no the soil only gives water and minerals the food is made in the leaves', lastStudentWasQuestion: true }));
  assert.equal(r.kind, 'acknowledge');
});

test('near the end, an explained concept is demonstrated back; failed twice -> no more tries', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  m.misconceptions = [];
  const taught = applyEvaluation(m, seg(GOOD_C1_TEXT), goodC1).model;
  const early = decideTurn(ctx({ model: taught, turnText: 'and the sugar gets stored in the plant for later', now: 20 }));
  assert.notEqual(early.kind, 'demonstrate');
  const late = decideTurn(ctx({ model: taught, turnText: 'and the sugar gets stored in the plant for later', now: 70 }));
  assert.equal(late.kind, 'demonstrate');
  const second = decideTurn(ctx({ model: taught, turnText: 'and the sugar gets stored in the plant for later', now: 80, demoAttempts: { c1: 1 } }));
  assert.equal((second as any).mode, 'apply', 'second attempt applies it to a new example');
  const done = decideTurn(ctx({ model: taught, turnText: 'and the sugar gets stored in the plant for later', now: 90, demoAttempts: { c1: 2 } }));
  assert.notEqual(done.kind, 'demonstrate');
});

// ---- Learning verification -------------------------------------------------------------

test('explained is not the same as demonstrated', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  m.misconceptions = [];
  const taught = applyEvaluation(m, seg(GOOD_C1_TEXT), goodC1).model;
  assert.equal(taught.concepts[0].explained, true);
  assert.equal(taught.concepts[0].verification, 'not_verified');
  assert.equal(conceptSummary(taught)[0].status, 'Not yet verified');
  assert.match(conceptSummary(taught)[0].note, /hasn't shown it back/);
});

test('a correct demonstration of a taught concept counts; of an untaught one it does not', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  const demo = { at: 60, mode: 'explain_back' as const, text: 'plants make sugar from light', verdict: 'demonstrated' as const, note: 'ok' };
  assert.equal(applyVerification(m, 'c1', demo).model.concepts[0].verification, 'partial', 'not taught yet: prior knowledge is not teaching success');
  m.misconceptions = [];
  const taught = applyEvaluation(m, seg(GOOD_C1_TEXT), goodC1).model;
  const r = applyVerification(taught, 'c1', demo);
  assert.equal(r.model.concepts[0].verification, 'demonstrated');
  assert.equal(conceptSummary(r.model)[0].status, 'Demonstrated understanding');
});

test('a failed demonstration never upgrades and never erases an earlier success', () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  m.misconceptions = [];
  const taught = applyEvaluation(m, seg(GOOD_C1_TEXT), goodC1).model;
  const fail = { at: 60, mode: 'explain_back' as const, text: 'plants eat dirt', verdict: 'not_demonstrated' as const, note: 'says plants eat soil' };
  const r1 = applyVerification(taught, 'c1', fail);
  assert.equal(r1.model.concepts[0].verification, 'not_verified');
  assert.match(conceptSummary(r1.model)[0].note, /got it wrong/);
  const ok = applyVerification(r1.model, 'c1', { ...fail, verdict: 'demonstrated', text: 'plants make sugar' });
  const again = applyVerification(ok.model, 'c1', fail);
  assert.equal(again.model.concepts[0].verification, 'demonstrated');
  assert.equal(applyVerification(taught, 'nope', fail).model, taught, 'unknown concept: unchanged');
  assert.equal(applyVerification(taught, 'c1', { ...fail, verdict: 'great' as any }).model, taught, 'bad verdict: unchanged');
});

test("the student's knowledge in the prompt changes as it learns", () => {
  const m = initStudentModel(EXTRACTION, 'middle');
  const before = knowledgeForPrompt(m);
  assert.match(before, /You believe: "Plants get their food from the soil\."/);
  assert.match(before, /What photosynthesis is: You don't know about this yet|What photosynthesis is: You know a little/);
  const fixed = applyEvaluation(m, seg('the soil only gives water and minerals but the food is sugar the plant makes itself from light'), proposal({ misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'the food is sugar the plant makes itself' }], concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'the food is sugar the plant makes itself', gap: '' }] })).model;
  const after = knowledgeForPrompt(fixed);
  assert.match(after, /used to believe "Plants get their food from the soil\.", but the teacher showed you that's wrong/);
  assert.doesNotMatch(after, /You believe: "Plants get their food/);
});

// ---- Streaming + voice -----------------------------------------------------------------

test('streamed text is split into speakable sentences', () => {
  assert.deepEqual(takeSentences('Wait, so the oxygen comes from water? And the'), { sentences: ['Wait, so the oxygen comes from water?'], rest: ' And the' });
  assert.deepEqual(takeSentences('It is 3.5 times bigger. Ok'), { sentences: ['It is 3.5 times bigger.'], rest: ' Ok' });
  assert.deepEqual(flushSentences('So basically light makes sugar'), ['So basically light makes sugar']);
  assert.deepEqual(takeSentences('Hmm... maybe? '), { sentences: ['Hmm... maybe?'], rest: ' ' });
});

test('the browser fallback prefers natural voices over robotic ones', () => {
  const v = (name: string, lang = 'en-US') => ({ name, lang });
  const ranked = [v('Fred'), v('Microsoft Aria Online (Natural) - English (United States)'), v('Google US English'), v('Zarvox'), v('Thomas', 'fr-FR')].sort((a, b) => scoreVoice(b) - scoreVoice(a));
  assert.equal(ranked[0].name, 'Microsoft Aria Online (Natural) - English (United States)');
  assert.equal(ranked[1].name, 'Google US English');
  assert.ok(scoreVoice(v('Zarvox')) < 0 && scoreVoice(v('Thomas', 'fr-FR')) < 0);
});
