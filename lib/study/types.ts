// Teach to Learn session records and the study planner's output. Stored
// separately from Learn to Teach records (different localStorage keys).

import type { Extraction, LevelId, Segment } from '../student/types.ts';
import type { BoardAnalysis, LearnerState, Understanding } from '../learner/types.ts';
import type { StudyEvidence, StudyFeedback } from '../learner/feedback.ts';

export interface PracticeAttempt {
  sessionId: string;
  at: string;
  understanding: Understanding; // of the practised concept in that session
}

export interface Practice {
  id: string;
  createdAt: string;
  fromSessionId: string;
  topic: string;
  topicKey: string;
  levelId: LevelId;
  conceptId: string;
  conceptName: string;
  kind: 'question' | 'challenge';
  prompt: string; // what the student will open the next session with
  lookFor: string[]; // what a complete answer covers (shown only after trying)
  status: 'open' | 'done';
  attempts: PracticeAttempt[];
  source: 'agent' | 'template';
}

export interface GapAnalysis {
  priority: { conceptId: string; name: string; why: string };
  misconceptions: { conceptId: string; name: string; quote: string; correction: string }[];
  missing: string[]; // concept names not covered
  unverified: string[]; // discussed but not shown to be understood
}

export interface PlanLogEntry {
  ms: number;
  type: 'step' | 'tool' | 'decision' | 'action' | 'error';
  name: string;
  detail: string;
}

export interface StudyPlan {
  sessionId: string;
  analysis: GapAnalysis | null;
  practice: Practice | null;
  practiceOutcome: { practiceId: string; understanding: Understanding } | null;
  recurring: string[]; // concept names that were gaps in earlier sessions too
  note: string; // the planner's note to itself for next time
  log: PlanLogEntry[];
  agent: 'deepagents' | 'fallback';
  error?: string;
}

export interface StudyRecord {
  version: 'study1';
  mode: 'student';
  id: string;
  createdAt: string;
  topicTitle: string;
  topicKey: string;
  levelId: LevelId;
  timeLimitSec: number;
  timeUsedSec: number;
  extraction: Extraction;
  learner: LearnerState;
  utterances: Segment[];
  boards: BoardAnalysis[]; // descriptions + small thumbnails
  manualChecked: string[]; // the user's own checkmarks (not AI-verified)
  feedback: StudyFeedback;
  evidence: StudyEvidence[];
  practiceId: string | null; // the practice this session attempted
  plan: { status: 'pending' | 'done' | 'failed'; agent?: string; error?: string } | null;
}

export const topicKeyOf = (title: string) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
