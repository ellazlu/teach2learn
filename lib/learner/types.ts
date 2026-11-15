// Teach to Learn: the USER is the learner. The AI student asks questions that
// expose gaps in the user's own understanding; this state tracks, per concept
// on the checklist, what the user has shown they understand.
//
// Explaining a concept is not the same as understanding it. A concept only
// counts as demonstrated when the user explained it accurately AND handled a
// follow-up question about it (reasoning, connections or a new case) without
// an error they left uncorrected.

import type { Correctness, Clarity, QuestionType } from '../student/types.ts';

export type Mode = 'educator' | 'student';
export const MODE_NAME: Record<Mode, string> = { educator: 'Learn to Teach', student: 'Teach to Learn' };
export const MODE_ROLE: Record<Mode, string> = { educator: 'Educator', student: 'Student' };

// Live checklist status.
export type Coverage = 'not_covered' | 'discussed' | 'demonstrated';
export const COVERAGE_LABEL: Record<Coverage, string> = { not_covered: 'Not covered', discussed: 'Discussed', demonstrated: 'Demonstrated' };

// End-of-session classification.
export type Understanding = 'demonstrated' | 'partial' | 'not_verified';
export const UNDERSTANDING_LABEL: Record<Understanding, string> = {
  demonstrated: 'Demonstrated understanding',
  partial: 'Partial understanding',
  not_verified: 'Not yet verified',
};

// How deep the student's questions on a concept go. Rises when the user
// answers well, drops after an error.
// 0 basics (what exactly) · 1 reasoning (why/how) · 2 connections and
// assumptions · 3 application to a new case / edge case
export type Depth = 0 | 1 | 2 | 3;

export interface Explanation {
  segmentId: string;
  at: number;
  quote: string;
  correctness: Correctness;
  clarity: Clarity;
  source: 'speech' | 'whiteboard';
}

export interface Probe {
  questionId: string;
  at: number;
  type: QuestionType;
  depth: Depth;
  text: string;
  answer: 'pending' | 'full' | 'partial' | 'none';
  correct: boolean | null; // null until answered
  quote: string; // the user's answer
}

export interface LearnerError {
  segmentId: string;
  at: number;
  quote: string;
  source: 'speech' | 'whiteboard';
  kind: 'incorrect' | 'endorsed_misconception';
  corrected: boolean; // the user later explained it correctly
  correctedQuote: string;
}

export interface Omission {
  at: number;
  question: string; // what a listener would still need to know
  quote: string;
}

export interface LearnerConcept {
  id: string;
  name: string;
  coverage: Coverage;
  mentioned: boolean;
  depth: Depth;
  explanations: Explanation[];
  probes: Probe[];
  errors: LearnerError[];
  omissions: Omission[];
  whiteboard: { at: number; snapshotId: string; quote: string }[];
}

export interface BoardAnalysis {
  id: string;
  at: number;
  transcription: string; // text/equations written, verbatim as read
  description: string; // what the drawing shows, neutrally
  conceptIds: string[];
  unclear: { part: string; question: string }[]; // never guessed
  blank: boolean;
  thumb?: string; // small JPEG data URL for history (optional)
  trigger: 'share' | 'pause' | 'end';
}

export interface LearnerState {
  version: 1;
  concepts: LearnerConcept[];
  focusConceptIds: string[]; // practice session focus, if any
  board: {
    latest: BoardAnalysis | null;
    pendingClarify: { snapshotId: string; part: string; question: string } | null;
    fresh: boolean; // latest board not yet discussed by the student
    askedClarify: string[]; // snapshot ids already asked about
  };
}
