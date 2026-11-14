// Turns final speech-recognition results into stable teacher segments, so the
// student model is evaluated on settled speech (never on partial/interim text),
// and keeps the student's own voice out of the teacher transcript.

import type { Segment } from './types.ts';
import { normalize, quoteAppearsIn } from '../verify.ts';

export const FLUSH_WORDS = 25; // flush once this many words have settled
export const FLUSH_PAUSE_SEC = 2.5; // ...or when the teacher pauses this long
export const MIN_PAUSE_WORDS = 6; // ...with at least this many words

export interface SegmentBuffer {
  parts: { text: string; start: number; end: number }[];
  words: number;
}

export const wordCount = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

export function emptyBuffer(): SegmentBuffer {
  return { parts: [], words: 0 };
}

export function addFinal(buf: SegmentBuffer, text: string, start: number, end: number): SegmentBuffer {
  const t = text.trim();
  if (!t) return buf;
  return { parts: [...buf.parts, { text: t, start, end: Math.max(start, end) }], words: buf.words + wordCount(t) };
}

export function shouldFlush(buf: SegmentBuffer, now: number): 'words' | 'pause' | null {
  if (!buf.parts.length) return null;
  if (buf.words >= FLUSH_WORDS) return 'words';
  const lastEnd = buf.parts[buf.parts.length - 1].end;
  if (buf.words >= MIN_PAUSE_WORDS && now - lastEnd >= FLUSH_PAUSE_SEC) return 'pause';
  return null;
}

export function bufferToSegment(buf: SegmentBuffer, id: string): Segment | null {
  if (!buf.parts.length) return null;
  return {
    id,
    speaker: 'teacher',
    text: buf.parts.map((p) => p.text).join(' '),
    start: buf.parts[0].start,
    end: buf.parts[buf.parts.length - 1].end,
  };
}

// Several queued teacher segments evaluated in one call (keeps API calls down).
export function mergeSegments(segs: Segment[]): Segment | null {
  const teacher = segs.filter((s) => s.speaker === 'teacher');
  if (!teacher.length) return null;
  if (teacher.length === 1) return teacher[0];
  return {
    id: teacher.map((s) => s.id).join('+'),
    speaker: 'teacher',
    text: teacher.map((s) => s.text).join(' '),
    start: teacher[0].start,
    end: teacher[teacher.length - 1].end,
  };
}

// True if recognized "teacher" text is really the student's synthesized voice
// leaking into the microphone.
export function isLikelyEcho(text: string, studentUtterances: string[]): boolean {
  const t = normalize(text);
  if (!t) return false;
  return studentUtterances.some((u) => {
    const s = normalize(u);
    if (!s) return false;
    if (t === s || s.includes(t)) return wordCount(t) >= 2 || t === s;
    return wordCount(t) >= 4 && quoteAppearsIn(t, s, 0.75);
  });
}
