import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEngine, type EngineDeps } from '../lib/student/engine.ts';
import { EXTRACTION, proposal } from './fixtures.ts';
import type { EvaluationProposal } from '../lib/student/types.ts';

const flush = async (n = 15) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function harness(over: Partial<EngineDeps> = {}, opts: { evalNever?: boolean; verdict?: string } = {}) {
  let t = 0;
  const calls = { evaluate: [] as any[], verify: [] as any[], reply: [] as any[], sentences: [] as string[], replyDoneAt: [] as number[] };
  const h = {
    calls,
    setClock: (v: number) => (t = v),
    replyText: ["Wait, don't plants get food from the soil?"] as string[],
    nextEval: proposal() as EvaluationProposal,
    engine: null as unknown as SessionEngine,
  };
  const deps: EngineDeps = {
    now: () => t,
    timeLimitSec: 120,
    seed: 3,
    evaluate: (b) => {
      calls.evaluate.push(b);
      return opts.evalNever ? new Promise(() => {}) : Promise.resolve(h.nextEval);
    },
    verify: async (b) => {
      calls.verify.push(b);
      return { verdict: (opts.verdict || 'demonstrated') as any, note: 'Got the key idea.' };
    },
    reply: async (body, onText, signal) => {
      calls.reply.push(body);
      let full = '';
      for (const chunk of h.replyText) {
        await new Promise((r) => setTimeout(r, 0));
        if (signal.aborted) throw new Error('aborted');
        full += chunk;
        onText(chunk);
      }
      calls.replyDoneAt.push(calls.sentences.length);
      return full;
    },
    voice: {
      begin: async () => {},
      sentence: async (text) => {
        calls.sentences.push(text);
        const start = t + 2; // audio starts 2s after the teacher stopped at t=5 below
        return { start, end: start + 1 };
      },
      end: () => {},
      cancel: () => {},
    },
    ...over,
  };
  h.engine = new SessionEngine('middle', deps);
  return h;
}

const EXPLAIN = 'so plants make their own food from sunlight water and carbon dioxide';

test("the student replies at the end of the teacher's turn, not mid-sentence", async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(5.5);
  h.engine.tick();
  await flush();
  assert.equal(h.calls.reply.length, 0, 'only 0.5s of silence: keep listening');
  h.setClock(6);
  h.engine.tick();
  await flush();
  assert.equal(h.calls.reply.length, 1, '0.9s+ of silence: reply');
  assert.equal(h.calls.reply[0].teacherJustSaid, EXPLAIN, 'replies to exactly what was just said');
  assert.match(h.calls.reply[0].knowledge, /You believe: "Plants get their food from the soil\."/);
});

test('the reply never waits for the background knowledge evaluation', async () => {
  const h = harness({}, { evalNever: true });
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush();
  assert.ok(h.calls.evaluate.length >= 1, 'evaluation started');
  assert.equal(h.calls.reply.length, 1, 'reply went ahead while the evaluation is still pending');
  assert.equal(h.calls.sentences.length, 1);
});

test('audio starts on the first sentence while the reply is still streaming', async () => {
  const h = harness();
  h.replyText = ['Wait, ', "don't plants get food ", 'from the soil? ', 'I thought ', 'they eat dirt.'];
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(5.9);
  h.engine.tick();
  await flush(40);
  assert.deepEqual(h.calls.sentences, ["Wait, don't plants get food from the soil?", 'I thought they eat dirt.']);
  assert.ok(h.calls.replyDoneAt[0] >= 1, 'the first sentence reached the voice before the stream finished');
  assert.deepEqual(h.engine.latencies, [2900], 'latency = audio start (7.9s) - end of teacher speech (5s)');
});

test('if the teacher keeps talking, the half-formed reply is dropped (no talking over them)', async () => {
  const h = harness();
  h.replyText = ['Wait, ', 'what?'];
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(6);
  h.engine.tick();
  h.engine.onTeacherInterim(); // teacher starts again before any audio
  await flush(30);
  assert.equal(h.calls.sentences.length, 0);
  assert.equal(h.engine.utterances.filter((u) => u.speaker === 'student').length, 0);
  h.engine.onTeacherFinal('and the leaves are where it happens', 6.5, 8);
  h.setClock(9);
  h.engine.tick();
  await flush(30);
  assert.match(h.calls.reply[1].teacherJustSaid, /carbon dioxide and the leaves are where it happens/, 'the dropped turn is kept and answered together');
});

test('short fragments get no reply', async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal('um so', 1, 2);
  h.setClock(3);
  h.engine.tick();
  await flush();
  assert.equal(h.calls.reply.length, 0);
  assert.match(h.engine.snapshot().lastDecision, /still getting going/);
});

test('when the teacher asks the student a question, it always answers, and the answer is verified', async () => {
  const h = harness();
  h.replyText = ['Um, I think plants get food from the soil?'];
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal('so what do you think plants need to make their food', 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush(30);
  assert.equal(h.calls.reply[0].intent, 'answer_content');
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.verify[0].mode, 'answer');
});

test('near the end the student explains back, and a correct one is marked demonstrated', async () => {
  const h = harness();
  h.replyText = ['So basically plants make sugar from light, water and air? Did I get it?'];
  h.nextEval = proposal({
    concepts: [{ concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: false, quote: 'plants make their own food', gap: '' }],
    misconceptions: [{ misconception_id: 'm1', effect: 'corrected', quote: 'plants make their own food' }],
  });
  const e = h.engine;
  e.setExtraction(EXTRACTION);
  e.onTeacherFinal(EXPLAIN + ' and that is why plants make their own food and do not eat soil', 60, 70);
  await flush(20); // background evaluation lands before the turn ends
  h.setClock(71);
  e.tick();
  await flush(40);
  assert.equal(h.calls.reply[0].intent, 'explain_back', `got ${h.calls.reply[0].intent}`);
  assert.equal(h.calls.verify[0].mode, 'explain_back');
  assert.equal(e.model!.concepts.find((c) => c.id === 'c1')!.verification, 'demonstrated');
  assert.ok(e.events.some((x) => x.type === 'demonstration' && x.verdict === 'demonstrated'));
});

test('a vague first sentence is replaced before any audio plays', async () => {
  const h = harness();
  h.replyText = ['Can you explain it another way? ', 'I am lost.'];
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5); // unvoiced misconception m1 -> code chooses a misconception question
  h.setClock(6);
  h.engine.tick();
  await flush(30);
  assert.equal(h.calls.reply[0].intent, 'misconception');
  assert.deepEqual(h.calls.sentences, ['Wait, but I thought plants get their food from the soil?']);
});

test("the student's own voice is never treated as teacher speech", async () => {
  const h = harness();
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush(30);
  h.engine.onTeacherFinal("wait don't plants get food from the soil", 9, 10);
  assert.equal(h.engine.utterances.filter((u) => u.speaker === 'teacher').length, 1);
});

test('a failed evaluation leaves the knowledge model unchanged and the conversation continues', async () => {
  const h = harness({ evaluate: async () => { throw new Error('down'); } });
  h.engine.setExtraction(EXTRACTION);
  const concepts = JSON.stringify(h.engine.model!.concepts);
  h.engine.onTeacherFinal(EXPLAIN, 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush(30);
  assert.equal(JSON.stringify(h.engine.model!.concepts), concepts);
  assert.equal(h.calls.reply.length, 1, 'still replied');
  assert.match(h.engine.snapshot().lastError, /conversation unaffected/);
});

test('finish waits for background verification', async () => {
  let release: (() => void) | null = null;
  const h = harness({ verify: () => new Promise((r) => (release = () => r({ verdict: 'partial', note: 'missing the role of light' }))) });
  h.replyText = ['Plants just need water, right?'];
  h.engine.setExtraction(EXTRACTION);
  h.engine.onTeacherFinal('what do you think plants need to make food', 1, 5);
  h.setClock(6);
  h.engine.tick();
  await flush(30);
  const done = h.engine.finish(2000);
  await flush();
  release!();
  await done;
  assert.equal(h.engine.model!.concepts.find((c) => c.id === 'c1')!.verification, 'partial');
});
