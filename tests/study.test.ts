import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initStudentModel, applyEvaluation } from '../lib/student/knowledge.ts';
import { recordQuestion } from '../lib/student/questions.ts';
import { cleanStudyExtraction } from '../lib/learner/checklist.ts';
import { initLearner, applyLearnerEvaluation, recordProbe } from '../lib/learner/tracker.ts';
import { buildStudyEvidence, fallbackStudyFeedback } from '../lib/learner/feedback.ts';
import { createPlannerState, createPlannerTools, searchMaterial } from '../lib/study/tools.ts';
import { runFallbackPlanner, runStudyPlanner, STUDY_PROMPT } from '../lib/study/planner.ts';
import {
  emptyStudyProfile, loadStudyProfile, saveStudyProfile, loadStudyHistory, saveStudyHistory, summarizeStudy, addStudySession,
  applyStudyPlan, topicsView, recurringGaps, historyForPlanner, currentPractice, STUDY_PROGRESS_KEY, STUDY_HISTORY_KEY,
} from '../lib/study/progress.ts';
import { PROGRESS_KEY, loadProfile } from '../lib/progress.ts';
import { KEY as HISTORY_KEY } from '../lib/history.ts';
import type { StudyRecord } from '../lib/study/types.ts';
import type { QuestionPlan } from '../lib/student/types.ts';
import { proposal, seg } from './fixtures.ts';

process.env.COACH_LOG = 'off';

const EXT = cleanStudyExtraction({
  topicTitle: 'Photosynthesis',
  overview: 'How plants make food.',
  concepts: [
    { id: 'c1', name: 'What photosynthesis is', description: 'Plants make sugar from light, water and carbon dioxide.', difficulty: 1, prerequisites: [], keyTerms: ['photosynthesis'] },
    { id: 'c2', name: 'Chlorophyll', description: 'Pigment that absorbs red and blue light.', difficulty: 2, prerequisites: ['c1'], keyTerms: ['chlorophyll'] },
    { id: 'c3', name: 'Where the oxygen comes from', description: 'The oxygen released comes from splitting water.', difficulty: 3, prerequisites: ['c1'], keyTerms: ['oxygen'] },
    { id: 'c4', name: 'Limiting factors', description: 'Light, CO2 and temperature limit the rate.', difficulty: 3, prerequisites: ['c1'], keyTerms: ['limiting'] },
    { id: 'c5', name: 'Calvin cycle', description: 'Fixes carbon dioxide into sugar using ATP.', difficulty: 4, prerequisites: ['c2'], keyTerms: ['Calvin'] },
  ],
  misconceptions: [],
} as any, true);

const plan = (conceptId: string): QuestionPlan => ({ kind: 'question', type: 'reasoning', conceptId, misconceptionId: null, followsQuestionId: null, focus: null, reason: '', score: 1 });
const ex = (id: string, quote: string, correctness: 'correct' | 'incorrect' = 'correct') =>
  proposal({ concepts: [{ concept_id: id, explained: true, correctness, clarity: 'clear', level_fit: 'appropriate', used_example: false, quote, gap: '' }] });

let n = 0;
function record(o: { wrongOxygen?: boolean; demonstrateC1?: boolean; practiceId?: string | null; at?: string } = {}): StudyRecord {
  let model = initStudentModel(EXT, 'high');
  let l = initLearner(EXT);
  const utterances: any[] = [];
  const say = (text: string, p: any, at: number) => {
    const s = seg(text, at);
    utterances.push({ id: `u${utterances.length}`, speaker: 'teacher', text, start: at, end: at + 5 });
    const r = applyEvaluation(model, s, p);
    model = r.model;
    l = applyLearnerEvaluation(l, s, p, model);
  };
  say('okay so photosynthesis is basically how plants make sugar from light water and carbon dioxide, it happens in the leaves of every green plant', ex('c1', 'plants make sugar from light water and carbon dioxide'), 5);
  if (o.demonstrateC1) {
    model = recordQuestion(model, plan('c1'), 'Why light?', 12);
    l = recordProbe(l, plan('c1'), model.questions.at(-1)!.id, 'Why light?', 12);
    utterances.push({ id: 'sq', speaker: 'student', text: 'Why light?', start: 12, end: 13 });
    say('light gives the energy needed to build the sugar', { ...ex('c1', 'light gives the energy needed to build the sugar'), question_response: { quality: 'full', quote: 'light gives the energy needed to build the sugar' } }, 15);
  }
  if (o.wrongOxygen) say('the oxygen that comes out is from the carbon dioxide', ex('c3', 'the oxygen that comes out is from the carbon dioxide', 'incorrect'), 30);
  const evidence = buildStudyEvidence(l, []);
  n += 1;
  return {
    version: 'study1', mode: 'student', id: `st${n}`, createdAt: o.at || `2026-11-${String(10 + n).padStart(2, '0')}T10:00:00Z`, topicTitle: 'Photosynthesis', topicKey: 'photosynthesis',
    levelId: 'high', timeLimitSec: 300, timeUsedSec: 120, extraction: EXT, learner: l, utterances, boards: [], manualChecked: [],
    feedback: fallbackStudyFeedback(l, evidence, EXT), evidence, practiceId: o.practiceId ?? null, plan: null,
  };
}

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

let ids = 0;
const det = { now: () => '2026-11-14T00:00:00Z', newId: () => `p${++ids}` };

test('planner tools: misconceptions must be their own words; practice must not give the answer', async () => {
  const r = record({ wrongOxygen: true });
  const s = createPlannerState({ session: r, history: null }, det);
  const tools = createPlannerTools(s);
  const call = async (name: string, a: object = {}) => JSON.parse(await tools.find((t) => t.name === name)!.run(a));
  const ov = await call('get_session_overview');
  assert.equal(ov.checklist.length, 5);
  assert.equal(ov.earlier_sessions, 0);
  const ev = await call('get_concept_evidence', { concept_id: 'c3' });
  assert.equal(ev[0].errors[0].corrected, false);
  assert.match((await call('get_concept_evidence', { concept_id: 'zz' })).error, /unknown concept_id/);
  const ranked = (await call('rank_knowledge_gaps')).ranked;
  assert.equal(ranked[0].concept_id, 'c3', 'uncorrected error ranks first');
  assert.match((await call('save_practice', { prompt: 'x', look_for: ['y'] })).error, /save_gap_analysis first/);
  const saved = await call('save_gap_analysis', {
    priority_concept_id: 'c3', why: 'They said the oxygen comes from CO2.',
    misconceptions_json: JSON.stringify([{ concept_id: 'c3', quote: 'the oxygen that comes out is from the carbon dioxide', correction: 'It comes from water.' }, { concept_id: 'c3', quote: 'plants breathe in oxygen at night only', correction: 'x' }]),
    missing_concept_ids: ['c4', 'c1'],
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.rejected_misconceptions_not_in_their_words.length, 1, 'invented quote rejected');
  assert.deepEqual(s.analysis!.missing, ['Limiting factors', 'Calvin cycle'].filter((x) => x === 'Limiting factors'), 'c1 was covered, so not "missing"');
  assert.match((await call('save_practice', { prompt: 'The oxygen released comes from splitting water, right?', look_for: ['x'] })).error, /gives away the answer/);
  assert.match((await call('save_practice', { prompt: 'If you grew a plant with water whose oxygen atoms were tagged, where would the tag end up?', look_for: [] })).error, /look_for/);
  const ok = await call('save_practice', { kind: 'challenge', prompt: 'If you grew a plant with water whose oxygen atoms were tagged, where would the tag end up?', look_for: ['Oxygen gas comes from water', 'CO2 oxygen ends up in sugar'] });
  assert.equal(ok.saved, true);
  assert.equal(s.practice!.conceptId, 'c3');
  assert.equal(s.log.filter((l) => l.type === 'tool' || l.type === 'error').length, 9, 'every call logged');
});

test('searchMaterial finds relevant passages in uploaded notes', () => {
  const notes = 'Chlorophyll absorbs red and blue light.\n\nThe oxygen released during photosynthesis comes from water molecules that are split.\n\nThe Calvin cycle fixes carbon.';
  assert.match(searchMaterial(notes, 'where does oxygen come from')[0], /comes from water/);
  assert.deepEqual(searchMaterial('', 'oxygen'), []);
});

test('fallback planner: prioritizes, saves practice, skips too-short sessions', async () => {
  const r = record({ wrongOxygen: true });
  const plan1 = await runFallbackPlanner(createPlannerState({ session: r, history: null }, det), 'test');
  assert.equal(plan1.agent, 'fallback');
  assert.equal(plan1.analysis!.priority.conceptId, 'c3');
  assert.equal(plan1.analysis!.misconceptions[0].quote, 'the oxygen that comes out is from the carbon dioxide');
  assert.match(plan1.practice!.prompt, /Last time you said/);
  assert.equal(plan1.practice!.source, 'template');
  assert.ok(plan1.log.some((l) => l.type === 'decision' && l.name === 'prioritize'));
  const short = record();
  short.utterances = [{ id: 'x', speaker: 'teacher', text: 'um so plants', start: 0, end: 1 }];
  const plan2 = await runFallbackPlanner(createPlannerState({ session: short, history: null }, det), 'test');
  assert.equal(plan2.analysis, null);
  assert.equal(plan2.practice, null);
});

function fakeDeps(script: (t: Map<string, any>) => Promise<any>, seen: any = {}) {
  const chain: any = { describe: () => chain, optional: () => chain };
  return async () => ({
    tool: (fn: any, cfg: any) => ({ ...cfg, invoke: fn }),
    z: { object: () => ({}), string: () => chain, number: () => chain, boolean: () => chain, array: () => chain, enum: () => chain },
    ChatAnthropic: class { constructor(o: any) { seen.model = o; } },
    createDeepAgent: (cfg: any) => { seen.cfg = cfg; return { invoke: async () => script(new Map(cfg.tools.map((t: any) => [t.name, t]))) }; },
  });
}

test('Deep Agents planner: agent-chosen calls, completion when it stops early, fallback on failure', async () => {
  const r = record({ wrongOxygen: true });
  const seen: any = {};
  const deps = fakeDeps(async (t) => {
    await t.get('get_session_overview').invoke({});
    await t.get('search_material').invoke({ query: 'oxygen water' });
    await t.get('rank_knowledge_gaps').invoke({});
    await t.get('save_gap_analysis').invoke({ priority_concept_id: 'c3', why: 'Said oxygen comes from CO2.' });
    await t.get('save_practice').invoke({ kind: 'question', prompt: 'What would happen to the oxygen a plant gives off if it had no water at all?', look_for: ['O2 comes from water'] });
    return { messages: [{ tool_calls: [{ name: 'write_todos', args: { todos: [{ content: 'investigate' }, { content: 'save' }] } }] }] };
  }, seen);
  const p = await runStudyPlanner({ session: r, history: null }, { apiKey: 'k', loadDeps: deps as any, ...det });
  assert.equal(p.agent, 'deepagents');
  assert.equal(p.practice!.source, 'agent');
  assert.equal(seen.cfg.systemPrompt, STUDY_PROMPT);
  assert.equal(seen.cfg.tools.length, 8);
  assert.ok(p.log.some((l) => l.name === 'write_todos'));

  const early = await runStudyPlanner({ session: r, history: null }, { apiKey: 'k', loadDeps: fakeDeps(async () => ({ messages: [] })) as any, ...det });
  assert.ok(early.analysis && early.practice, 'completed deterministically');
  assert.ok(early.log.some((l) => l.name === 'complete'));
  const boom = await runStudyPlanner({ session: r, history: null }, { apiKey: 'k', loadDeps: fakeDeps(async () => { throw new Error('529'); }) as any, ...det });
  assert.equal(boom.agent, 'fallback');
  assert.ok(boom.practice);
  const nokey = await runStudyPlanner({ session: r, history: null }, det);
  assert.match(nokey.error!, /No ANTHROPIC_API_KEY/);
});

test('progress: separate storage from Learn to Teach, persists, tracks recurring gaps and practice', async () => {
  const store = memStore();
  let p = loadStudyProfile(store);
  assert.deepEqual(p, emptyStudyProfile(), 'first-time user');
  const r1 = record({ wrongOxygen: true, at: '2026-11-01T10:00:00Z' });
  p = addStudySession(p, summarizeStudy(r1));
  const plan1 = await runFallbackPlanner(createPlannerState({ session: r1, history: historyForPlanner(p, r1.id) }, det), 't');
  p = applyStudyPlan(p, plan1);
  const pr = currentPractice(p)!;
  assert.equal(pr.conceptId, 'c3');

  // Second session: a practice attempt that still misses c3.
  const r2 = record({ wrongOxygen: true, practiceId: pr.id, at: '2026-11-02T10:00:00Z' });
  p = addStudySession(p, summarizeStudy(r2));
  const plan2 = await runFallbackPlanner(createPlannerState({ session: r2, history: historyForPlanner(p, r2.id) }, det), 't');
  assert.ok(plan2.recurring.includes('Where the oxygen comes from'), 'recurring gap found');
  assert.equal(plan2.practiceOutcome!.understanding, 'not_verified');
  assert.ok(plan2.log.some((l) => l.name === 'get_previous_study_sessions'));
  p = applyStudyPlan(p, plan2);
  assert.equal(p.practice.find((x) => x.id === pr.id)!.attempts.length, 1);

  // Third session: demonstrates c1, corrects nothing on c3.
  const r3 = record({ demonstrateC1: true, at: '2026-11-03T10:00:00Z' });
  p = addStudySession(p, summarizeStudy(r3));
  const view = topicsView(p)[0];
  assert.equal(view.sessions, 3);
  assert.equal(view.concepts.find((c) => c.name === 'What photosynthesis is')!.latest, 'demonstrated');
  assert.deepEqual(view.concepts.find((c) => c.name === 'What photosynthesis is')!.history, ['partial', 'partial', 'demonstrated']);
  assert.ok(view.remaining.includes('Where the oxygen comes from'));
  assert.ok(!view.remaining.includes('What photosynthesis is'));
  assert.ok(recurringGaps(p, 'photosynthesis').includes('Limiting factors'));

  assert.ok(saveStudyProfile(p, store));
  assert.deepEqual(loadStudyProfile(store).sessions.map((s) => s.id), p.sessions.map((s) => s.id));
  assert.ok(saveStudyHistory([r3, r2, r1], store));
  assert.equal(loadStudyHistory(store).length, 3);
  assert.deepEqual([...store.m.keys()].sort(), [STUDY_HISTORY_KEY, STUDY_PROGRESS_KEY].sort());
  assert.ok(![...store.m.keys()].includes(PROGRESS_KEY) && ![...store.m.keys()].includes(HISTORY_KEY), 'Learn to Teach keys untouched');
  assert.deepEqual(loadProfile(store).sessions, [], 'Learn to Teach progress sees none of it');
  store.setItem(STUDY_PROGRESS_KEY, '{bad');
  assert.deepEqual(loadStudyProfile(store), emptyStudyProfile(), 'corrupt storage -> empty');
});

test('study history: drops thumbnails before dropping sessions when storage is tight', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (v.length > 40000) throw new Error('quota'); m.set(k, v); } };
  const recs = [record(), record()].map((r) => ({ ...r, boards: [{ id: 'w1', at: 1, transcription: 'x', description: 'y', conceptIds: [], unclear: [], blank: false, trigger: 'share' as const, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(30000) }] }));
  assert.ok(saveStudyHistory(recs, store));
  const back = loadStudyHistory(store);
  assert.equal(back.length, 2);
  assert.equal(back[0].boards[0].thumb, undefined);
  assert.equal(back[0].boards[0].transcription, 'x', 'whiteboard evidence kept');
});
