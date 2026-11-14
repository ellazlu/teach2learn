import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { initStudentModel, applyEvaluation, applyVerification, learningSummary, conceptSummary } from '../lib/student/knowledge.ts';
import { computeSpeechMetrics } from '../lib/student/speech.ts';
import { buildEvidence, fallbackThree } from '../lib/student/evidence.ts';
import { recordQuestion } from '../lib/student/questions.ts';
import { createState, createTools } from '../lib/coach/tools.ts';
import { runFallbackCoach } from '../lib/coach/fallback.ts';
import { runCoach, zodSchema, COACH_PROMPT } from '../lib/coach/agent.ts';
import { scoreSession, factsFrom } from '../lib/coach/rubric.ts';
import { addSession, applyCoachResult, emptyProfile, historyForCoach, summarize, currentChallenge, recurringWeaknesses } from '../lib/progress.ts';
import type { SessionRecord } from '../lib/history.ts';
import type { Challenge } from '../lib/coach/challenges.ts';
import { EXTRACTION, seg, proposal, goodC1 } from './fixtures.ts';
import type { Segment } from '../lib/student/types.ts';

process.env.COACH_LOG = 'off';
const T = (text: string, start: number, end: number): Segment => ({ id: `t${start}`, speaker: 'teacher', text, start, end });
const words = (n: number) => Array.from({ length: n }, (_, i) => ['plants', 'use', 'light', 'to', 'make', 'sugar'][i % 6]).join(' ');

// A realistic session record. `jargon` adds undefined terms; `monologue` a 100s
// run with no check-in; `demo` a correct explain-back; `checks` check-ins.
function makeSession(id: string, at: string, o: { jargon?: number; monologue?: boolean; demo?: boolean; checks?: boolean; challengeId?: string | null } = {}): SessionRecord {
  let m = initStudentModel(EXTRACTION, 'middle');
  const initial = structuredClone(m);
  const events: any[] = [];
  let r = applyEvaluation(m, seg('plants make their own food using sunlight water and carbon dioxide from the air', 5), goodC1);
  events.push(...r.events);
  m = r.model;
  const terms = ['thylakoid', 'stroma', 'photolysis'].slice(0, o.jargon || 0);
  for (const [i, term] of terms.entries()) {
    r = applyEvaluation(m, seg(`then the ${term} does its job`, 40 + i * 5), proposal({ undefined_terms: [{ term, quote: `the ${term}` }] }));
    events.push(...r.events);
    m = r.model;
  }
  if (o.checks) events.push({ type: 'checked_understanding', segmentId: 'x', at: 30, quote: 'does that make sense' });
  if (o.demo) {
    const v = applyVerification(m, 'c1', { at: 70, mode: 'explain_back', text: 'they make sugar from light', verdict: 'demonstrated', note: 'ok' });
    m = v.model;
    events.push(...v.events);
  }
  m = recordQuestion(m, { kind: 'question', type: 'clarify', conceptId: 'c1', misconceptionId: null, followsQuestionId: null, reason: '', score: 1 }, 'Where does the sugar go?', 80);
  const utterances: Segment[] = o.monologue
    ? [T(words(260), 0, 100), { id: 's1', speaker: 'student', text: 'Where does the sugar go?', start: 102, end: 104 }]
    : [T(words(60) + (o.checks ? ' does that make sense?' : ''), 0, 30), T(words(60), 33, 60), { id: 's1', speaker: 'student', text: 'Where does the sugar go?', start: 80, end: 82 }];
  const checks = events.filter((e) => e.type === 'checked_understanding').map((e) => e.at);
  const metrics = computeSpeechMetrics(utterances, checks);
  const learning = learningSummary(initial, m);
  const evidence = buildEvidence({ initial, final: m, events, metrics, learning });
  return {
    version: 4, id, createdAt: at, topicId: 'photo', topicTitle: 'Photosynthesis', levelId: 'middle', timeLimitSec: 120, timeUsedSec: 110,
    extraction: EXTRACTION, initialModel: initial, finalModel: m, events, utterances, metrics, learning, concepts: conceptSummary(m),
    teaching: fallbackThree(evidence), evidence, usedFallback: true, latencies: [], challengeId: o.challengeId ?? null,
  };
}

let ids = 0;
const det = { now: () => '2026-11-14T00:00:00Z', newId: () => `ch${++ids}` };

function record(p: ReturnType<typeof emptyProfile>, s: SessionRecord) {
  const sc = scoreSession({ levelId: s.levelId, utterances: s.utterances, events: s.events, metrics: s.metrics, evidence: s.evidence, finalModel: s.finalModel });
  return addSession(p, summarize(s, sc, factsFrom({ levelId: s.levelId, utterances: s.utterances, events: s.events, metrics: s.metrics, evidence: s.evidence, finalModel: s.finalModel })));
}

// ---- Tools ---------------------------------------------------------------------------

test('tools return JSON, log each call, and report fixable errors', async () => {
  const s = createState({ session: makeSession('a', '2026-11-01', { jargon: 2 }), history: null, activeChallenge: null }, det);
  const tools = createTools(s);
  assert.ok(!tools.some((t) => t.name === 'check_previous_challenge'), 'no challenge attempted -> tool not offered');
  const call = async (n: string, a: object = {}) => JSON.parse(await tools.find((t) => t.name === n)!.run(a));
  const ov = await call('get_session_overview');
  assert.equal(ov.topic, 'Photosynthesis');
  assert.equal(ov.previous_sessions, 0);
  const ev = await call('get_transcript_evidence', { category: 'communication', include_transcript: true });
  assert.ok(ev.evidence.every((e: any) => e.category === 'communication') && ev.evidence.length >= 1);
  assert.match(ev.transcript, /Tutor:/);
  // Order is up to the agent: saving before analysis is rejected with a hint.
  assert.match((await call('save_practice_challenge', { title: 'x' })).error, /save_evaluation first/);
  const sc = await call('score_session');
  assert.equal(sc.ratings.communication.score, 2, '4 - 2 undefined terms');
  assert.match((await call('save_evaluation', { focus_skill: 'charm', reason: 'x' })).error, /must be one of/);
  assert.match((await call('save_evaluation', { focus_skill: 'accuracy', reason: 'x' })).error, /weakness this session showed/);
  const ok = await call('save_evaluation', { focus_skill: 'clear_language', reason: 'Used thylakoid and stroma without defining them.', evidence_ids: ['E1', 'E99'] });
  assert.equal(ok.saved, true);
  assert.deepEqual(ok.ignored_unknown_evidence_ids, ['E99']);
  assert.match((await call('save_practice_challenge', { title: 'T', goal: 'G', student_profile: 'P', criteria_json: '[{"metric":"undefined_terms","target":9}]' })).error, /target must be between/);
  assert.match((await call('save_practice_challenge', { criteria_json: 'nope' })).error, /JSON array/);
  const saved = await call('save_practice_challenge', { title: 'No jargon', goal: 'Define every term.', student_profile: 'New to biology; asks what words mean.', criteria_json: '[{"metric":"undefined_terms","target":0}]' });
  assert.equal(saved.saved, true);
  assert.equal(s.challenge!.scenario.topic, 'Photosynthesis', 'defaults to the same topic and level');
  assert.equal(s.log.filter((l) => l.type === 'tool').length + s.log.filter((l) => l.type === 'error').length, 10, 'one log entry per call');
  assert.ok(s.log.every((l) => typeof l.ms === 'number' && l.detail.length <= 300));
});

// ---- Fallback coach: the full loop across sessions ------------------------------------

test('first session: deterministic coach scores, diagnoses, and creates a challenge', async () => {
  const sess = makeSession('s1', '2026-11-01T10:00:00Z', { jargon: 2, monologue: true });
  const r = await runFallbackCoach(createState({ session: sess, history: null, activeChallenge: null }, det), 'test');
  assert.equal(r.agent, 'fallback');
  assert.ok(r.evaluation, 'focus saved');
  assert.ok(r.challenge, 'challenge saved');
  assert.equal(r.challenge!.skill, r.evaluation!.focusSkill);
  assert.equal(r.challenge!.source, 'template');
  assert.equal(r.challengeOutcome, null);
  assert.equal(r.trend.engagement.previousAvg, null, 'no fabricated trend on a first session');
  const steps = r.log.filter((l) => l.type === 'step').map((l) => l.name);
  assert.deepEqual(steps, ['investigate', 'analyze', 'compare', 'act']);
  assert.ok(r.log.some((l) => l.type === 'decision' && l.name === 'diagnose'));
  assert.ok(!r.log.some((l) => l.name === 'get_previous_sessions'), 'no history call for a first-time user');
});

test('too-short session: no ratings, nothing saved, current challenge kept', async () => {
  const sess = makeSession('s0', '2026-11-01');
  sess.utterances = [T('hi so um', 0, 2)];
  const r = await runFallbackCoach(createState({ session: sess, history: null, activeChallenge: null }, det), 'test');
  assert.equal(r.evaluation, null);
  assert.equal(r.challenge, null);
  assert.ok(Object.values(r.ratings).every((x) => x.score === null));
  let p = applyCoachResult(emptyProfile(), r);
  assert.equal(p.currentChallengeId, null);
});

test('cross-session loop: challenge -> partial attempt -> retry -> met -> harder or new focus', async () => {
  let p = emptyProfile();
  // Session 1: jargon + monologue.
  const s1 = makeSession('s1', '2026-11-01T10:00:00Z', { jargon: 2, monologue: true });
  p = record(p, s1);
  let r = await runFallbackCoach(createState({ session: s1, history: historyForCoach(p, 's1'), activeChallenge: null }, det), 't');
  p = applyCoachResult(p, r);
  const ch1 = currentChallenge(p)!;
  assert.ok(ch1);
  assert.equal(p.sessions[0].focusSkill, ch1.skill);

  // Session 2 attempts ch1 but repeats the same problems -> not addressed; retry.
  const s2 = makeSession('s2', '2026-11-02T10:00:00Z', { jargon: 2, monologue: true, challengeId: ch1.id });
  p = record(p, s2);
  r = await runFallbackCoach(createState({ session: s2, history: historyForCoach(p, 's2'), activeChallenge: currentChallenge(p) }, det), 't');
  assert.ok(r.challengeOutcome);
  assert.ok(['not_addressed', 'partly_addressed'].includes(r.challengeOutcome!.verdict), r.challengeOutcome!.verdict);
  assert.equal(r.challenge!.id, ch1.id, 'retried the same challenge');
  assert.match(r.challengeOutcome!.adjustment, /same challenge/);
  assert.ok(r.recurring.includes(ch1.skill), 'flagged as recurring');
  assert.ok(r.log.some((l) => l.name === 'check_previous_challenge'));
  assert.ok(r.log.some((l) => l.name === 'get_previous_sessions'));
  p = applyCoachResult(p, r);
  assert.equal(p.challenges.find((c) => c.id === ch1.id)!.attempts.length, 1);
  assert.ok(recurringWeaknesses(p).some((x) => x.skill === ch1.skill && x.status === 'persisting'));

  // Session 3 attempts ch1 again, cleanly -> addressed; coach moves on or levels up.
  const s3 = makeSession('s3', '2026-11-03T10:00:00Z', { demo: true, checks: true, challengeId: ch1.id });
  p = record(p, s3);
  r = await runFallbackCoach(createState({ session: s3, history: historyForCoach(p, 's3'), activeChallenge: currentChallenge(p) }, det), 't');
  assert.equal(r.challengeOutcome!.verdict, 'addressed', JSON.stringify(r.challengeOutcome!.attempt.results));
  assert.notEqual(r.challenge!.id, ch1.id, 'a met challenge is not retried');
  p = applyCoachResult(p, r);
  const done = p.challenges.find((c) => c.id === ch1.id)!;
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.attempts.map((a) => a.sessionId), ['s2', 's3']);
  assert.ok(done.attempts[1].met > done.attempts[0].met, 'same criteria, compared across attempts');
  assert.ok(r.trend.communication.delta !== null, 'trend computed from real earlier ratings');
});

// ---- Deep Agents path, with a fake agent standing in for the model ----------------------

function fakeDeps(script: (tools: Map<string, any>) => Promise<any>, seen: any = {}) {
  return async () => ({
    tool: (fn: any, cfg: any) => ({ ...cfg, invoke: fn }),
    z: null,
    ChatAnthropic: class { constructor(o: any) { seen.model = o; } },
    createDeepAgent: (cfg: any) => {
      seen.cfg = cfg;
      return { invoke: async (input: any, opts: any) => { seen.input = input; seen.opts = opts; return script(new Map(cfg.tools.map((t: any) => [t.name, t]))); } };
    },
  });
}
// zodSchema is exercised separately with real zod; the fake deps skip it.
const noZod = (deps: any) => async () => ({ ...(await deps()), z: { object: () => ({}), string: () => chain, number: () => chain, boolean: () => chain, array: () => chain, enum: () => chain } });
const chain: any = { describe: () => chain, optional: () => chain };

test('agent path: the agent chooses tool order; results and log come from its calls', async () => {
  const seen: any = {};
  const sess = makeSession('s1', '2026-11-01', { jargon: 2 });
  const deps = noZod(fakeDeps(async (t) => {
    await t.get('get_session_overview').invoke({});
    await t.get('score_session').invoke({});
    await t.get('compare_with_previous').invoke({});
    await t.get('save_evaluation').invoke({ focus_skill: 'clear_language', reason: 'Two terms were never explained.', evidence_ids: ['E1'] });
    await t.get('save_practice_challenge').invoke({ title: 'Plain words', goal: 'Define each new word.', student_profile: 'A curious 12-year-old who stops you at every unfamiliar word.', criteria_json: '[{"metric":"undefined_terms","target":0},{"metric":"rating_communication","target":4}]' });
    return { messages: [{ tool_calls: [{ name: 'write_todos', args: { todos: [{ content: 'score' }, { content: 'plan' }] } }, { name: 'score_session', args: {} }] }, { content: 'Saved.' }] };
  }, seen));
  const r = await runCoach({ session: sess, history: null, activeChallenge: null }, { apiKey: 'k', loadDeps: deps, ...det });
  assert.equal(r.agent, 'deepagents');
  assert.equal(r.challenge!.source, 'agent');
  assert.equal(r.challenge!.title, 'Plain words');
  assert.equal(r.evaluation!.focusSkill, 'clear_language');
  assert.equal(seen.cfg.systemPrompt, COACH_PROMPT);
  assert.equal(seen.opts.recursionLimit, 40);
  assert.equal(seen.model.apiKey, 'k');
  assert.ok(seen.cfg.tools.length === 8, 'check_previous_challenge withheld when nothing to check');
  assert.ok(r.log.some((l) => l.name === 'write_todos' && /plan: score \| plan/.test(l.detail)), 'built-in planning call logged');
  assert.ok(!r.log.some((l) => l.detail.includes('Saved.')), 'model text is never logged');
});

test('agent path: stopping early is completed deterministically; failures fall back', async () => {
  const sess = makeSession('s1', '2026-11-01', { jargon: 2 });
  const early = noZod(fakeDeps(async (t) => { await t.get('score_session').invoke({}); return { messages: [] }; }));
  const r1 = await runCoach({ session: sess, history: null, activeChallenge: null }, { apiKey: 'k', loadDeps: early, ...det });
  assert.equal(r1.agent, 'deepagents');
  assert.ok(r1.evaluation && r1.challenge);
  assert.ok(r1.log.some((l) => l.type === 'decision' && l.name === 'complete'));

  const boom = noZod(fakeDeps(async () => { throw new Error('529 overloaded'); }));
  const r2 = await runCoach({ session: sess, history: null, activeChallenge: null }, { apiKey: 'k', loadDeps: boom, ...det });
  assert.equal(r2.agent, 'fallback');
  assert.match(r2.error!, /529/);
  assert.ok(r2.challenge);

  const slow = noZod(fakeDeps(() => new Promise(() => {})));
  const r3 = await runCoach({ session: sess, history: null, activeChallenge: null }, { apiKey: 'k', loadDeps: slow, timeoutMs: 50, ...det });
  assert.match(r3.error!, /timed out/);

  const missing = async () => { throw new Error("Cannot find package 'deepagents'"); };
  const r4 = await runCoach({ session: sess, history: null, activeChallenge: null }, { apiKey: 'k', loadDeps: missing as any, ...det });
  assert.equal(r4.agent, 'fallback');
  assert.ok(r4.log.some((l) => l.name === 'fallback' && /Deep Agents unavailable/.test(l.detail)));

  const nokey = await runCoach({ session: sess, history: null, activeChallenge: null }, { ...det });
  assert.equal(nokey.agent, 'fallback');
});

test('agent path: a skipped challenge check is still run', async () => {
  let p = emptyProfile();
  const s1 = makeSession('s1', '2026-11-01', { jargon: 2 });
  p = applyCoachResult(record(p, s1), await runFallbackCoach(createState({ session: s1, history: null, activeChallenge: null }, det), 't'));
  const ch = currentChallenge(p) as Challenge;
  const s2 = makeSession('s2', '2026-11-02', { challengeId: ch.id, checks: true });
  const deps = noZod(fakeDeps(async () => ({ messages: [] })));
  const r = await runCoach({ session: s2, history: historyForCoach(p, 's2'), activeChallenge: ch }, { apiKey: 'k', loadDeps: deps, ...det });
  assert.ok(r.challengeOutcome, 'outcome computed even though the agent skipped it');
  assert.equal(r.challengeOutcome!.challengeId, ch.id);
});

const ZOD = '/opt/npm-tools/node_modules/zod/index.js';
test('tool schemas convert to valid zod objects', { skip: !existsSync(ZOD) && 'zod not available' }, async () => {
  const { z } = await import(ZOD);
  const s = createState({ session: makeSession('a', '2026-11-01'), history: null, activeChallenge: null }, det);
  for (const t of createTools(s)) {
    const schema = zodSchema(z, t.params);
    assert.ok(schema.safeParse({}).success || Object.values(t.params).some((p) => !p.optional), t.name);
  }
  const ev = zodSchema(z, createTools(s).find((t) => t.name === 'save_evaluation')!.params);
  assert.ok(ev.safeParse({ focus_skill: 'accuracy', reason: 'r', evidence_ids: ['E1'] }).success);
  assert.ok(!ev.safeParse({ focus_skill: 'nope', reason: 'r' }).success, 'enum enforced');
});
