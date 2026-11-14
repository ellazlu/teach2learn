import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSpeechMetrics, countFillers } from '../lib/student/speech.ts';
import { buildEvidence, attachEvidence, fallbackSuggestions } from '../lib/student/evidence.ts';
import { initStudentModel, applyEvaluation, learningSummary } from '../lib/student/knowledge.ts';
import { recordQuestion } from '../lib/student/questions.ts';
import { loadHistory, saveHistory, migrate, KEY } from '../lib/history.ts';
import { EXTRACTION, seg, proposal } from './fixtures.ts';
import type { Segment } from '../lib/student/types.ts';

const T = (text: string, start: number, end: number): Segment => ({ id: `t${start}`, speaker: 'teacher', text, start, end });
const S = (text: string, start: number, end: number): Segment => ({ id: `s${start}`, speaker: 'student', text, start, end });
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

// ---- Speech metrics ------------------------------------------------------------

test('WPM comes from measured timestamps only', () => {
  const m = computeSpeechMetrics([T(words(30), 0, 10), T(words(30), 10.5, 20), T(words(50), 25, 25)]);
  assert.equal(m.teacherWords, 110);
  assert.equal(m.teacherSpeakingSec, 19.5);
  assert.equal(m.wordsPerMinute, Math.round(60 / (19.5 / 60)), 'untimed (typed) words are excluded from pace');
  assert.equal(computeSpeechMetrics([T(words(30), 0, 5)]).wordsPerMinute, null, 'too little timed speech -> no WPM');
});

test('long pauses, monologues, response latency and talk share', () => {
  const m = computeSpeechMetrics([
    T(words(20), 0, 30),
    T(words(20), 32, 62),
    T(words(20), 63, 95), // one 95s run
    T(words(5), 105, 108), // 10s pause before this
    S('What is chlorophyll?', 110, 113),
    T(words(10), 122, 126), // answered 9s after the question
  ]);
  assert.equal(m.longestRun!.seconds, 95);
  assert.deepEqual(m.runsOver90s, [{ start: 0, seconds: 95 }]);
  assert.deepEqual(m.longPauses, [{ at: 95, seconds: 10 }]);
  assert.deepEqual(m.responseLatencies, [{ questionAt: 110, seconds: 9 }]);
  assert.equal(m.studentSpeakingSec, 3);
  assert.ok(m.teacherShare! > 0.9);
});

test('fillers are counted, analogies with "like" are not', () => {
  assert.deepEqual(countFillers("um so it's like a kitchen, and like, uh, you know"), { um: 1, uh: 1, 'you know': 1, like: 1 });
});

// ---- Evidence-based feedback ---------------------------------------------------------

function sessionWithIssues() {
  let m = initStudentModel(EXTRACTION, 'middle');
  const initial = structuredClone(m);
  const events = [];
  let r = applyEvaluation(m, seg('the photolysis splits water inside the thylakoid', 42), proposal({ undefined_terms: [{ term: 'thylakoid', quote: 'inside the thylakoid' }] }));
  events.push(...r.events);
  m = recordQuestion(r.model, { kind: 'question', type: 'misconception', conceptId: 'c1', misconceptionId: 'm1', followsQuestionId: null, reason: '', score: 2 }, "Don't plants eat dirt?", 135);
  r = applyEvaluation(m, seg('anyway the calvin cycle uses the energy', 140), proposal());
  events.push(...r.events);
  m = r.model;
  const metrics = computeSpeechMetrics([T(words(200), 0, 100), S("Don't plants eat dirt?", 135, 137), T(words(10), 140, 145)]);
  return { initial, final: m, events, metrics, learning: learningSummary(initial, m) };
}

test('evidence is timestamped and grounded in what happened', () => {
  const ev = buildEvidence(sessionWithIssues());
  const term = ev.find((e) => e.kind === 'undefined_term')!;
  assert.equal(term.at, 42);
  assert.match(term.label, /thylakoid/);
  assert.ok(ev.some((e) => e.kind === 'misconception_unaddressed' && e.at === 135));
  assert.ok(ev.some((e) => e.kind === 'long_run' && e.at === 0));
  assert.ok(ev.some((e) => e.kind === 'question_unanswered'));
  assert.deepEqual(ev.map((e) => e.id), ev.map((_, i) => `E${i + 1}`));
});

test('LLM suggestions without valid evidence are dropped', () => {
  const ev = buildEvidence(sessionWithIssues());
  const kept = attachEvidence(
    [
      { title: 'Define thylakoid first', detail: 'At 0:42…', evidence_ids: [ev[0].id] },
      { title: 'Try being clearer', detail: 'Generic.', evidence_ids: [] },
      { title: 'Made up', detail: 'x', evidence_ids: ['E999'] },
    ],
    ev
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].evidence[0].at, ev[0].at);
});

test('without the LLM, suggestions still come from evidence', () => {
  const s = fallbackSuggestions(buildEvidence(sessionWithIssues()));
  assert.ok(s.length >= 3);
  assert.ok(s.every((x) => x.evidence.length >= 1));
  assert.ok(s.filter((x) => x.title === 'Cover the rest of the material').length <= 1, 'uncovered concepts are grouped');
});

// ---- Persistence --------------------------------------------------------------------------

function fakeStorage() {
  const data = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  return data;
}

test('saved sessions restore correctly', () => {
  fakeStorage();
  const { initial, final, events, metrics, learning } = sessionWithIssues();
  const rec = {
    version: 3 as const, id: 's-1', createdAt: '2026-11-14T20:00:00Z', topicId: 't', topicTitle: 'Photosynthesis', levelId: 'middle' as const,
    timeLimitSec: 120, timeUsedSec: 100, extraction: EXTRACTION, initialModel: initial, finalModel: final, events, utterances: [],
    metrics, learning, feedback: { summary: 'ok', suggestions: [], strengths: [], outside_knowledge: [], evidence: [], usedFallback: true },
  };
  assert.equal(saveHistory([rec]), true);
  const [back] = loadHistory();
  assert.deepEqual(back, rec);
});

test('older rubric-era sessions stay readable and deletes stick', () => {
  const data = fakeStorage();
  data.set('teach2learn-history-v1', JSON.stringify([
    { id: 'old', createdAt: '2026-11-13T20:00:00Z', planId: 'p', levelId: 'high', timeLimitSec: 60, plan: { topic_title: 'Old topic' }, session: { transcript: 'hi', notes: [], timeUsedSec: 50 }, grade: { score: { percent: 70 }, suggestions: ['Do X'], summary: 'Fine.' } },
    { garbage: true },
  ]));
  const list = loadHistory();
  assert.equal(list.length, 1);
  assert.equal(list[0].version, 1);
  assert.equal(list[0].topicTitle, 'Old topic');
  saveHistory(list); // migrated into the current key
  assert.equal(loadHistory().length, 1);
  saveHistory([]); // delete it
  assert.equal(loadHistory().length, 0, 'deleted legacy session does not come back');
  assert.equal(migrate(null), null);
  assert.ok(data.has(KEY));
});
