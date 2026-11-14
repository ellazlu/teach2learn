// Lightweight speech analysis from real timestamps.
//
// Every utterance carries client-clock timestamps captured from speech
// recognition events: `start` = when the recognizer first reported that
// utterance (first interim result), `end` = when it became final. Student
// utterances are timed from text-to-speech start/end events. Nothing here
// estimates duration from text length; utterances without a measured
// duration are excluded from rate calculations.

import type { Segment, SpeechMetrics } from './types.ts';
import { wordCount } from './segments.ts';

export const LONG_PAUSE_SEC = 4;
export const RUN_GAP_SEC = 4; // a gap shorter than this keeps one "uninterrupted" run going
export const MONOLOGUE_FLAG_SEC = 90;
const MIN_MEASURED_SEC = 15; // need this much timed speech before reporting WPM

// Filler patterns. Speech recognizers often drop "um"/"uh", so counts are a lower bound.
// "like" is only counted in filler positions ("and like", "so like"), never as a
// comparison ("it's like a kitchen"), because analogies are good teaching.
export const FILLERS: [string, RegExp][] = [
  ['um', /\b(um+|erm+|hmm+)\b/g],
  ['uh', /\b(uh+|er)\b/g],
  ['you know', /\byou know\b/g],
  ['I mean', /\bi mean\b/g],
  ['like', /\b(and|so|but|just|was|were)\s+like\b/g],
  ['basically', /\bbasically\b/g],
];

export function countFillers(text: string): Record<string, number> {
  const t = text.toLowerCase();
  const out: Record<string, number> = {};
  for (const [label, re] of FILLERS) {
    const n = (t.match(re) || []).length;
    if (n) out[label] = n;
  }
  return out;
}

export function computeSpeechMetrics(utterances: Segment[], checksForUnderstanding: number[] = []): SpeechMetrics {
  const teacher = utterances.filter((u) => u.speaker === 'teacher').sort((a, b) => a.start - b.start);
  const student = utterances.filter((u) => u.speaker === 'student').sort((a, b) => a.start - b.start);
  const dur = (u: Segment) => Math.max(0, u.end - u.start);

  const teacherWords = teacher.reduce((n, u) => n + wordCount(u.text), 0);
  const timed = teacher.filter((u) => dur(u) >= 0.5);
  const teacherSpeakingSec = timed.reduce((n, u) => n + dur(u), 0);
  const timedWords = timed.reduce((n, u) => n + wordCount(u.text), 0);
  const studentSpeakingSec = student.reduce((n, u) => n + dur(u), 0);

  const fillers: Record<string, number> = {};
  for (const u of teacher) for (const [k, v] of Object.entries(countFillers(u.text))) fillers[k] = (fillers[k] || 0) + v;

  const longPauses: SpeechMetrics['longPauses'] = [];
  const responseLatencies: SpeechMetrics['responseLatencies'] = [];
  const runs: { start: number; end: number; words: number }[] = [];
  let run: { start: number; end: number; words: number } | null = null;

  for (let i = 0; i < teacher.length; i++) {
    const u = teacher[i];
    const prev = teacher[i - 1];
    const between = prev ? student.filter((s) => s.start >= prev.end - 0.01 && s.start < u.start) : [];
    if (prev && between.length) {
      const last = between[between.length - 1];
      responseLatencies.push({ questionAt: last.start, seconds: round1(Math.max(0, u.start - last.end)) });
    } else if (prev && u.start - prev.end >= LONG_PAUSE_SEC) {
      longPauses.push({ at: round1(prev.end), seconds: round1(u.start - prev.end) });
    }
    const continues = run && !between.length && u.start - run.end < RUN_GAP_SEC;
    if (run && continues) {
      run.end = Math.max(run.end, u.end);
      run.words += wordCount(u.text);
    } else {
      if (run) runs.push(run);
      run = { start: u.start, end: u.end, words: wordCount(u.text) };
    }
  }
  if (run) runs.push(run);

  const longest = runs.reduce<(typeof runs)[number] | null>((best, r) => (!best || r.end - r.start > best.end - best.start ? r : best), null);
  const total = teacherSpeakingSec + studentSpeakingSec;

  return {
    teacherWords,
    teacherSpeakingSec: round1(teacherSpeakingSec),
    studentSpeakingSec: round1(studentSpeakingSec),
    wordsPerMinute: teacherSpeakingSec >= MIN_MEASURED_SEC ? Math.round(timedWords / (teacherSpeakingSec / 60)) : null,
    longPauses,
    fillerCount: Object.values(fillers).reduce((a, b) => a + b, 0),
    fillers,
    longestRun: longest ? { start: round1(longest.start), end: round1(longest.end), seconds: round1(longest.end - longest.start), words: longest.words } : null,
    runsOver90s: runs.filter((r) => r.end - r.start >= MONOLOGUE_FLAG_SEC).map((r) => ({ start: round1(r.start), seconds: Math.round(r.end - r.start) })),
    responseLatencies,
    checksForUnderstanding: [...checksForUnderstanding].sort((a, b) => a - b),
    teacherShare: teacherSpeakingSec > 0 && studentSpeakingSec > 0 ? Math.round((teacherSpeakingSec / total) * 100) / 100 : null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
