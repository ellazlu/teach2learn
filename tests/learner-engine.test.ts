// The shared session engine in Teach to Learn mode, plus checks that Learn to
// Teach behaves exactly as before when no mode is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine, type EngineDeps } from '../lib/student/engine.ts';
import { EXTRACTION, proposal } from './fixtures.ts';
import type { EvaluationProposal } from '../lib/student/types.ts';
import { cleanBoard } from '../lib/learner/whiteboard.ts';

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function harness(over: Partial<EngineDeps> = {}) {
  let t = 0;
  const calls = { evaluate: [] as any[], verify: [] as any[], reply: [] as any[], sentences: [] as string[] };
  const h = { calls, setClock: (v: number) => (t = v), evals: [] as EvaluationProposal[], replyText: 'Why do they need the light though?', engine: null as unknown as SessionEngine };
  const deps: EngineDeps = {
    now: () => t,
    timeLimitSec: 300,
    seed: 3,
    evaluate: (b) => {
      calls.evaluate.push(b);
      return Promise.resolve(h.evals.shift() || proposal());
    },
    verify: async (b) => {
      calls.verify.push(b);
      return { verdict: 'demonstrated', note: '' };
    },
    reply: async (body, onText) => {
      calls.reply.push(body);
      await new Promise((r) => setTimeout(r, 0));
      onText(h.replyText);
      return h.replyText;
    },
    voice: {
      begin: async () => {},
      sentence: async (text) => {
        calls.sentences.push(text);
        return { start: t + 1, end: t + 2 };
      },
      end: () => {},
      cancel: () => {},
    },
    ...over,
  };
  h.engine = new SessionEngine('high', deps);
  return h;
}

const EXPLAIN = 'photosynthesis is how plants make sugar from light water and carbon dioxide';
const good = proposal({ concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'plants make sugar from light water and carbon dioxide', gap: '' }] });

test('Learn to Teach is unchanged when no mode is given: no learner state, no mode in replies', async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal('so plants make their own food from sunlight water and carbon dioxide', 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush();
  assert.equal(h.engine.learner, null);
  assert.equal(h.calls.reply[0].mode, undefined);
  assert.equal(h.calls.reply[0].outline, undefined);
  h.engine.addBoard(cleanBoard({ transcription: 'x', description: 'y', concept_ids: [], unclear: [] }, { id: 'w1', at: 1, trigger: 'share', conceptIds: [] }));
  assert.equal(h.engine.boards.length, 0, 'whiteboard is ignored outside Teach to Learn');
});

test('Teach to Learn: replies carry the mode and outline; probes are recorded and judged', async () => {
  const h = harness({ mode: 'student' });
  h.engine.setExtraction(EXTRACTION);
  h.evals.push(good);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush();
  const body = h.calls.reply[0];
  assert.equal(body.mode, 'student');
  assert.deepEqual(body.outline, EXTRACTION.concepts.map((c) => c.name));
  const c1 = h.engine.learner!.concepts.find((c) => c.id === 'c1')!;
  assert.equal(c1.explanations.length, 1, 'background evaluation fed the checklist');
  assert.equal(c1.coverage, 'discussed', 'explained, not yet demonstrated');
  const q = h.engine.model!.questions[h.engine.model!.questions.length - 1];
  assert.ok(q, 'the student asked something');
  const probe = h.engine.learner!.concepts.flatMap((c) => c.probes).find((p) => p.questionId === q.id);
  assert.ok(probe, 'the question is tracked as a probe of the user');
  assert.equal(h.calls.verify.length, 0, "the AI student's own answers aren't graded in this mode");
});

test('Teach to Learn: a shared whiteboard is evaluated as evidence and the student asks about it', async () => {
  const h = harness({ mode: 'student' });
  h.engine.setExtraction(EXTRACTION);
  await flush();
  h.replyText = 'Is that word under the arrow "glucose"?';
  h.evals.push(proposal({ concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: '6CO2 + 6H2O -> C6H12O6 + 6O2', gap: '' }] }));
  const a = cleanBoard(
    { transcription: '6CO2 + 6H2O -> C6H12O6 + 6O2', description: 'a sun with an arrow to a leaf', concept_ids: ['c1'], unclear: [{ part: 'the word under the arrow', question: 'Is that word glucose?' }] },
    { id: 'w1', at: 10, trigger: 'share', conceptIds: ['c1', 'c2', 'c3'] },
  );
  h.setClock(10);
  h.engine.addBoard(a);
  await flush();
  const evalCall = h.calls.evaluate.find((b) => /On the whiteboard they wrote/.test(b.segment));
  assert.ok(evalCall, 'board content went through the same evaluation as speech');
  assert.doesNotMatch(evalCall.segment, /under the arrow/, 'unclear part not judged');
  assert.equal(h.calls.reply.length, 1, 'student responded to the shared board');
  assert.equal(h.calls.reply[0].intent, 'board_clarify', 'unclear drawing -> asks, never guesses');
  assert.equal(h.calls.reply[0].board.transcription, '6CO2 + 6H2O -> C6H12O6 + 6O2');
  const c1 = h.engine.learner!.concepts.find((c) => c.id === 'c1')!;
  assert.equal(c1.explanations[0].source, 'whiteboard');
  assert.equal(h.engine.learner!.board.pendingClarify, null);
});

test('Teach to Learn: a whiteboard snapshot is never merged with speech for evaluation', async () => {
  const h = harness({ mode: 'student' });
  h.engine.setExtraction(EXTRACTION);
  h.engine.addBoard(cleanBoard({ transcription: 'light -> sugar', description: '', concept_ids: [], unclear: [] }, { id: 'w1', at: 3, trigger: 'pause', conceptIds: [] }));
  h.engine.onTeacherFinal('and then the leaves use that light to build sugar for the whole plant to grow taller', 4, 9);
  await h.engine.finish(500);
  const segs = h.calls.evaluate.map((b) => b.segment);
  assert.ok(segs.some((x) => x.startsWith('On the whiteboard')));
  assert.ok(segs.every((x) => !(x.startsWith('On the whiteboard') && x.includes('leaves use'))));
  assert.equal(h.calls.reply.length, 0, 'a pause snapshot does not make the student talk');
});

test('Teach to Learn practice: the student opens with the planned question', async () => {
  const h = harness({ mode: 'student', opening: { text: 'If a plant were kept in the dark for a week, what would happen to its sugar?', conceptId: 'c1' }, focusConceptIds: ['c1'] });
  h.engine.setExtraction(EXTRACTION);
  await flush();
  assert.equal(h.calls.sentences[0], 'If a plant were kept in the dark for a week, what would happen to its sugar?');
  assert.equal(h.calls.reply.length, 0, 'spoken as planned, no model call');
  const probe = h.engine.learner!.concepts.find((c) => c.id === 'c1')!.probes[0];
  assert.equal(probe.type, 'apply_new');
  assert.deepEqual(h.engine.learner!.focusConceptIds, ['c1']);
});
