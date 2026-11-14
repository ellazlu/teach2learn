// Glue between saved session records, the rubric and the progress store.
// Browser-safe: no network, no server-only imports.

import type { SessionRecord } from '../history.ts';
import { factsFrom, scoreSession, type ScorableSession } from './rubric.ts';
import { addSession, summarize, type TutorProfile } from '../progress.ts';
import { createState } from './tools.ts';
import { runFallbackCoach } from './fallback.ts';
import type { Challenge } from './challenges.ts';
import type { CoachResult } from './types.ts';

const scorable = (r: SessionRecord): ScorableSession => ({
  levelId: r.levelId,
  utterances: r.utterances || [],
  events: r.events || [],
  metrics: r.metrics || null,
  evidence: r.evidence || [],
  finalModel: r.finalModel || null,
});

export function rateRecord(r: SessionRecord) {
  const s = scorable(r);
  return { facts: factsFrom(s), scores: r.ratings || scoreSession(s) };
}

export function addRecordToProfile(p: TutorProfile, r: SessionRecord): TutorProfile {
  const { facts, scores } = rateRecord(r);
  return addSession(p, summarize(r, scores, facts));
}

// Sessions saved before progress tracking existed are added from their real
// data (deterministic scoring), oldest first. Nothing is estimated.
export function backfillProfile(p: TutorProfile, records: { version: number; id: string }[]): TutorProfile {
  const have = new Set(p.sessions.map((s) => s.id));
  let next = p;
  for (const r of records) if (r.version === 4 && !have.has(r.id)) next = addRecordToProfile(next, r as SessionRecord);
  return next;
}

// Used when the coach service can't be reached: the same deterministic coach,
// run in the browser.
export function runLocalCoach(input: { session: SessionRecord; history: any; activeChallenge: Challenge | null; coachNotes?: string }, reason: string): Promise<CoachResult> {
  return runFallbackCoach(createState(input), reason);
}

export function coachSummary(r: CoachResult) {
  return {
    status: 'done' as const,
    agent: r.agent,
    focusSkill: r.evaluation?.focusSkill ?? null,
    reason: r.evaluation?.reason || '',
    nextChallengeId: r.challenge?.id ?? null,
    challengeTitle: r.challenge?.title ?? null,
    outcome: r.challengeOutcome
      ? { verdict: r.challengeOutcome.verdict, met: r.challengeOutcome.attempt.met, total: r.challengeOutcome.attempt.total, judged: r.challengeOutcome.attempt.judged, adjustment: r.challengeOutcome.adjustment }
      : null,
    ...(r.error ? { error: r.error } : {}),
  };
}
