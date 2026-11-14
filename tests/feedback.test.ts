import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSpeechMetrics, countFillers } from '../lib/student/speech.ts';
import { buildEvidence, validateThree, fallbackThree, cleanText } from '../lib/student/evidence.ts';
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

test('feedback is exactly three items, each tied to valid evidence of the right kind', () => {
  const ev = buildEvidence(sessionWithIssues());
  const good = ev.find((e) => e.positive);
  const bad = ev.find((e) => !e.positive)!;
  const r = validateThree(
    {
      went_well: { text: 'At 0:42 you did great!', evidence_id: bad.id }, // cites an issue as a strength: rejected
      improve: { text: 'At 1:07, you used "thylakoid" without saying what it is.', evidence_id: bad.id },
      try_next: { text: 'Define new words the first time.', evidence_id: 'E999' }, // invalid id: falls back
    },
    ev
  );
  assert.equal(r.improve!.evidence!.id, bad.id);
  assert.doesNotMatch(r.improve!.text, /1:07/, 'invented timestamps are stripped; the app shows real ones');
  assert.equal(r.went_well?.evidence?.positive ?? true, true);
  if (!good) assert.equal(r.went_well, null, 'no positive evidence -> no invented praise');
  assert.ok(r.try_next && r.try_next.text);
  assert.equal(r.usedFallback, true);
});

test('without the LLM, the three items still come from evidence', () => {
  const f = fallbackThree(buildEvidence(sessionWithIssues()));
  assert.ok(f.improve && f.improve.evidence);
  assert.ok(f.try_next && f.try_next.text.length > 10);
  assert.equal(cleanText('around 2:15, you did x'), 'You did x');
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
    version: 4 as const, id: 's-1', createdAt: '2026-11-14T20:00:00Z', topicId: 't', topicTitle: 'Photosynthesis', levelId: 'middle' as const,
    timeLimitSec: 120, timeUsedSec: 100, extraction: EXTRACTION, initialModel: initial, finalModel: final, events, utterances: [],
    metrics, learning, concepts: [], teaching: { went_well: null, improve: null, try_next: null }, evidence: [], usedFallback: true, latencies: [1200],
  };
  assert.equal(saveHistory([rec]), true);
  const [back] = loadHistory();
  assert.deepEqual(back, rec);
});

test('sessions saved by the previous version (v3) stay readable', () => {
  const data = fakeStorage();
  data.set('teach2learn-history-v3', JSON.stringify([{ version: 3, id: 'v3', createdAt: '2026-11-14T10:00:00Z', topicId: 't', topicTitle: 'Gravity', levelId: 'high', timeLimitSec: 120, timeUsedSec: 90, utterances: [{ speaker: 'teacher', text: 'gravity pulls' }], feedback: { summary: 'Okay.', suggestions: [{ title: 'Define terms', detail: 'Say what orbit means.' }] } }]));
  const [r] = loadHistory();
  assert.equal(r.version, 1);
  assert.equal(r.topicTitle, 'Gravity');
  assert.deepEqual((r as any).suggestions, ['Define terms: Say what orbit means.']);
  assert.match((r as any).transcript, /You: gravity pulls/);
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
