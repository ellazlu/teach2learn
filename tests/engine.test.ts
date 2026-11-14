import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine, type EngineDeps } from '../lib/student/engine.ts';
import { EXTRACTION, proposal } from './fixtures.ts';
import type { EvaluationProposal } from '../lib/student/types.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

function harness(over: Partial<EngineDeps> = {}) {
  let clock = 0;
  const calls = { evaluate: [] as any[], speak: [] as any[], say: [] as string[], maxConcurrent: 0 };
  let inFlight = 0;
  let nextProposal: EvaluationProposal | Error = proposal();
  const deps: EngineDeps = {
    now: () => clock,
    seed: 1,
    evaluate: async (body) => {
      calls.evaluate.push(body);
      inFlight++;
      calls.maxConcurrent = Math.max(calls.maxConcurrent, inFlight);
      await tick();
      inFlight--;
      if (nextProposal instanceof Error) throw nextProposal;
      return nextProposal;
    },
    speak: async (body) => {
      calls.speak.push(body);
      return { text: 'Wait, but don\'t plants eat dirt?' };
    },
    say: async (text) => {
      calls.say.push(text);
      const start = clock;
      clock += 3;
      return { start, end: clock };
    },
    ...over,
  };
  const engine = new SessionEngine('middle', deps);
  return {
    engine,
    calls,
    setClock: (t: number) => (clock = t),
    setProposal: (p: EvaluationProposal | Error) => (nextProposal = p),
  };
}

const LONG = 'so plants make their own food using sunlight water and carbon dioxide from the air and that whole process happens inside the green leaves of the plant';

test('speech before the model is ready is queued, then evaluated', async () => {
  const h = harness();
  h.engine.onTeacherFinal(LONG, 1, 6);
  await settle();
  assert.equal(h.calls.evaluate.length, 0);
  h.engine.setExtraction(EXTRACTION);
  await settle();
  assert.equal(h.calls.evaluate.length, 1);
  assert.match(h.calls.evaluate[0].segment, /plants make their own food/);
});

test('evaluations never overlap; queued segments are merged', async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  for (let i = 0; i < 5; i++) h.engine.onTeacherFinal(LONG, i * 10, i * 10 + 6);
  await settle(30);
  assert.equal(h.calls.maxConcurrent, 1);
  assert.ok(h.calls.evaluate.length < 5, `merged into ${h.calls.evaluate.length} calls`);
  const all = h.calls.evaluate.map((c) => c.segment).join(' ');
  assert.equal(all.split('plants make their own food').length - 1, 5, 'every segment evaluated exactly once');
});

test('a failed evaluation keeps the previous state and the session continues', async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  const before = JSON.stringify(h.engine.model);
  h.setProposal(new Error('network down'));
  h.engine.onTeacherFinal(LONG, 1, 6);
  await settle(20);
  assert.equal(JSON.stringify(h.engine.model), before);
  assert.match(h.engine.snapshot().lastError, /network down/);
  assert.equal(h.calls.evaluate.length, 2, 'retried once, then dropped');
  h.setProposal(proposal({ concepts: [{ concept_id: 'c2', explained: false, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'green leaves of the plant' }] }));
  h.engine.onTeacherFinal(LONG, 20, 26);
  await settle(20);
  assert.equal(h.engine.model!.concepts.find((c) => c.id === 'c2')!.mentioned, true, 'later segments still work');
});

test('the student asks, the mic echo is ignored, and an answer resolves the question', async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  h.setClock(40);
  h.setProposal(proposal({ concepts: [{ concept_id: 'c1', explained: true, correctness: 'partially_correct', clarity: 'somewhat_clear', level_fit: 'appropriate', used_example: false, quote: 'plants make their own food using sunlight' }] }));
  h.engine.onTeacherFinal(LONG, 30, 40);
  await settle(30);
  assert.equal(h.calls.say.length, 1, 'student spoke once');
  assert.equal(h.calls.speak[0].intent, 'misconception', 'code chose the intent, not the LLM');
  const m = h.engine.model!;
  assert.equal(m.questions.length, 1);
  assert.equal(m.misconceptions.find((x) => x.id === 'm1')!.expressed, true);

  // The student's own voice leaking into the mic is dropped.
  h.engine.onTeacherFinal("wait but don't plants eat dirt", 44, 46);
  assert.equal(h.engine.utterances.filter((u) => u.speaker === 'teacher').length, 1);

  // Teacher answers.
  h.setProposal(proposal({
    misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'no the soil only gives water and minerals' }],
    question_response: { quality: 'full', quote: 'no the soil only gives water and minerals' },
  }));
  h.engine.onTeacherFinal('no the soil only gives water and minerals but the food itself is sugar made in the leaves using light energy from the sun', 50, 58);
  await settle(5);
  assert.equal(h.engine.model!.questions[0].status, 'pending', '24 words: waits for a pause before evaluating');
  h.setClock(61); // teacher pauses for 3s
  h.engine.tick();
  await settle(30);
  const after = h.engine.model!;
  assert.equal(after.questions[0].status, 'answered');
  assert.equal(after.misconceptions.find((x) => x.id === 'm1')!.status, 'resolved');
  assert.ok(h.engine.utterances.some((u) => u.speaker === 'student' && u.end - u.start === 3), 'student timing comes from the speech callback');
});

test('no second interjection while the student is still speaking', async () => {
  let release: (() => void) | null = null;
  const h = harness({
    say: (text) =>
      new Promise((resolve) => {
        h.calls.say.push(text);
        release = () => resolve({ start: 40, end: 43 });
      }),
  });
  h.engine.setExtraction(EXTRACTION);
  h.setClock(40);
  h.setProposal(proposal({ concepts: [{ concept_id: 'c1', explained: true, correctness: 'partially_correct', clarity: 'somewhat_clear', level_fit: 'appropriate', used_example: false, quote: 'plants make their own food using sunlight' }] }));
  h.engine.onTeacherFinal(LONG, 30, 40);
  await settle(30);
  assert.equal(h.engine.snapshot().speaking, true);
  assert.equal(h.engine.snapshot().behavior, 'responding');
  assert.equal(h.engine.decide().kind, 'none');
  h.engine.onTeacherFinal('and the leaves are green', 39, 41); // started before the student spoke: kept
  h.engine.onTeacherFinal(LONG, 41, 42); // started while the student was speaking: ignored
  assert.equal(h.engine.utterances.filter((u) => u.speaker === 'teacher').length, 2);
  await settle(30);
  assert.equal(h.calls.say.length, 1);
  release!();
  await settle(10);
  assert.equal(h.engine.snapshot().behavior, 'listening');
});

test('finish waits for the last evaluation and blocks new actions', async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal('plants are cool', 1, 2); // too short to flush on its own
  await settle();
  assert.equal(h.calls.evaluate.length, 0);
  await h.engine.finish(1000);
  assert.equal(h.calls.evaluate.length, 1, 'remaining words were flushed and evaluated');
  assert.equal(h.calls.speak.length, 0);
});
