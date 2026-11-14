import type { Scores, Skill } from './rubric.ts';
import type { Attempt, Challenge } from './challenges.ts';

// Developer log: observable steps, tool calls, decisions and actions only.
// Never the model's private reasoning.
export interface CoachLogEntry {
  ms: number; // since the coach started
  type: 'step' | 'tool' | 'decision' | 'action' | 'error';
  name: string;
  detail: string;
}

export interface Evaluation {
  focusSkill: Skill;
  reason: string;
  evidenceIds: string[];
}

export type Verdict = 'addressed' | 'partly_addressed' | 'not_addressed' | 'not_enough_evidence';

export interface ChallengeOutcome {
  challengeId: string;
  skill: Skill;
  attempt: Attempt;
  verdict: Verdict;
  adjustment: string; // what the coach changed for the next challenge
}

export interface CategoryTrend {
  current: number | null;
  previousAvg: number | null; // mean of up to 3 earlier rated sessions
  delta: number | null;
}

export interface CoachResult {
  sessionId: string;
  ratings: Scores;
  evaluation: Evaluation | null;
  challenge: Challenge | null;
  challengeOutcome: ChallengeOutcome | null;
  trend: Record<'engagement' | 'communication' | 'teaching', CategoryTrend>;
  recurring: Skill[];
  log: CoachLogEntry[];
  coachNote: string; // the coach's note to itself for the next review (persistent context)
  agent: 'deepagents' | 'fallback';
  error?: string;
}
