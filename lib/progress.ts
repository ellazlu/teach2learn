// Tutor progress across sessions (localStorage). Stores a compact summary of
// each session (date, topic, ratings, speech metrics, feedback), the practice
// challenges and their attempts, and the coach's last activity log. Nothing
// here is estimated: a value that wasn't measured is stored as null and shown
// as a gap, never filled in.

import type { LevelId, StudentModel } from './student/types.ts';
import { CATEGORIES, SKILLS, type Category, type Scores, type SessionFacts, type Skill, weaknesses } from './coach/rubric.ts';
import type { Attempt, Challenge } from './coach/challenges.ts';
import type { CoachLogEntry, CoachResult } from './coach/types.ts';

export const PROGRESS_KEY = 'teach2learn-tutor-v1';
export const MAX_SESSIONS = 100;

export interface SessionSummary {
  id: string;
  at: string;
  topic: string;
  levelId: LevelId;
  timeUsedSec: number;
  ratings: Record<Category, number | null> & { overall?: number | null };
  scale?: 100; // absent = saved under the old 1-5 rubric
  explanations: Record<Category, string>;
  metrics: {
    wpm: number | null;
    fillersPerMin: number | null;
    maxRunSec: number | null;
    checkIns: number;
    questionsAsked: number; // by the student
    questionsAnswered: number;
  };
  weaknesses: Skill[]; // this session's, most severe first
  focusSkill: Skill | null; // the coach's single priority
  challengeId: string | null; // the challenge this session attempted
  feedback: { went_well: string; improve: string; try_next: string };
  // Lightweight student knowledge state at the end of the session.
  student: { concepts: { name: string; verification: string; mastery: number }[]; misconceptionsResolved: number; misconceptionsTotal: number };
}

export interface TutorProfile {
  version: 1;
  sessions: SessionSummary[]; // oldest first
  challenges: Challenge[]; // oldest first
  currentChallengeId: string | null;
  lastCoachLog: { sessionId: string; agent: string; error?: string; log: CoachLogEntry[] } | null;
  coachNotes?: string;
}

export const emptyProfile = (): TutorProfile => ({ version: 1, sessions: [], challenges: [], currentChallengeId: null, lastCoachLog: null, coachNotes: '' });

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage);

export function loadProfile(store: Store | null = defaultStore()): TutorProfile {
  if (!store) return emptyProfile();
  try {
    const raw = JSON.parse(store.getItem(PROGRESS_KEY) || 'null');
    if (!raw || raw.version !== 1 || !Array.isArray(raw.sessions) || !Array.isArray(raw.challenges)) return emptyProfile();
    return {
      version: 1,
      // Old 1-5 summaries are dropped here; the page re-adds them from saved
      // session records, rescored on the 0-100 rubric (never converted by guesswork).
      sessions: raw.sessions.filter((s: any) => s && s.id && s.at && s.ratings && s.scale === 100),
      challenges: raw.challenges
        .filter((c: any) => c && c.id && c.skill && Array.isArray(c.attempts))
        // Rating targets set under the old 1-5 rubric move to the 0-100 scale.
        .map((c: any) => ({ ...c, criteria: (c.criteria || []).map((k: any) => (String(k.metric).startsWith('rating_') && k.target <= 5 ? { ...k, target: k.target * 20 } : k)) })),
      currentChallengeId: typeof raw.currentChallengeId === 'string' ? raw.currentChallengeId : null,
      lastCoachLog: raw.lastCoachLog || null,
      coachNotes: typeof raw.coachNotes === 'string' ? raw.coachNotes : '',
    };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(p: TutorProfile, store: Store | null = defaultStore()): boolean {
  if (!store) return false;
  let sessions = p.sessions.slice(-MAX_SESSIONS);
  for (;;) {
    try {
      store.setItem(PROGRESS_KEY, JSON.stringify({ ...p, sessions }));
      return true;
    } catch {
      if (sessions.length <= 1) return false;
      sessions = sessions.slice(Math.ceil(sessions.length / 4)); // drop the oldest quarter
    }
  }
}

export const currentChallenge = (p: TutorProfile): Challenge | null =>
  p.challenges.find((c) => c.id === p.currentChallengeId && c.status === 'active') || null;

export interface SummaryInput {
  id: string;
  createdAt: string;
  topicTitle: string;
  levelId: LevelId;
  timeUsedSec: number;
  teaching: { went_well: { text: string } | null; improve: { text: string } | null; try_next: { text: string } | null };
  finalModel: StudentModel | null;
  challengeId?: string | null;
}

export function summarize(r: SummaryInput, scores: Scores, f: SessionFacts): SessionSummary {
  const mis = r.finalModel?.misconceptions || [];
  return {
    id: r.id,
    at: r.createdAt,
    topic: r.topicTitle,
    levelId: r.levelId,
    timeUsedSec: r.timeUsedSec,
    ratings: { engagement: scores.engagement.score, communication: scores.communication.score, teaching: scores.teaching.score, overall: scores.overall },
    scale: 100,
    explanations: { engagement: scores.engagement.explanation, communication: scores.communication.explanation, teaching: scores.teaching.explanation },
    metrics: {
      wpm: f.wpm,
      fillersPerMin: f.fillersPerMin,
      maxRunSec: f.maxRunSec,
      checkIns: f.invitations,
      questionsAsked: f.studentQuestions,
      questionsAnswered: f.answered,
    },
    weaknesses: weaknesses(scores).map((w) => w.skill),
    focusSkill: null,
    challengeId: r.challengeId || null,
    feedback: { went_well: r.teaching.went_well?.text || '', improve: r.teaching.improve?.text || '', try_next: r.teaching.try_next?.text || '' },
    student: {
      concepts: (r.finalModel?.concepts || []).map((c) => ({ name: c.name, verification: c.verification || 'not_verified', mastery: Math.round(c.mastery) })),
      misconceptionsResolved: mis.filter((m) => m.status === 'resolved').length,
      misconceptionsTotal: mis.length,
    },
  };
}

export function addSession(p: TutorProfile, s: SessionSummary): TutorProfile {
  const sessions = p.sessions.filter((x) => x.id !== s.id).concat(s).sort((a, b) => a.at.localeCompare(b.at));
  return { ...p, sessions };
}

// Merge the coach's output into the profile: focus skill on the session, the
// attempt on the challenge it practised, and the new challenge as current.
export function applyCoachResult(p: TutorProfile, r: CoachResult): TutorProfile {
  let challenges = p.challenges.map((c) => ({ ...c, attempts: [...c.attempts] }));
  if (r.challengeOutcome) {
    const c = challenges.find((x) => x.id === r.challengeOutcome!.challengeId);
    if (c && !c.attempts.some((a) => a.sessionId === r.challengeOutcome!.attempt.sessionId)) {
      c.attempts.push(r.challengeOutcome.attempt);
      if (r.challengeOutcome.verdict === 'addressed') c.status = 'completed';
    }
  }
  let currentChallengeId = p.currentChallengeId;
  if (r.challenge) {
    const existing = challenges.find((x) => x.id === r.challenge!.id);
    if (existing) Object.assign(existing, { ...r.challenge, attempts: existing.attempts });
    else {
      for (const c of challenges) if (c.status === 'active') c.status = 'replaced';
      challenges.push({ ...r.challenge, status: 'active' });
    }
    currentChallengeId = r.challenge.id;
  } else if (currentChallengeId && !challenges.find((c) => c.id === currentChallengeId && c.status === 'active')) {
    currentChallengeId = null;
  }
  const sessions = p.sessions.map((s) =>
    s.id === r.sessionId ? { ...s, focusSkill: r.evaluation?.focusSkill ?? s.focusSkill } : s,
  );
  return {
    ...p,
    sessions,
    challenges,
    currentChallengeId,
    lastCoachLog: { sessionId: r.sessionId, agent: r.agent, error: r.error, log: r.log },
    coachNotes: r.coachNote || p.coachNotes || '',
  };
}

// ---- Views ---------------------------------------------------------------------------

export interface ChartSeries {
  points: { id: string; at: string; topic: string; value: number | null }[];
  category: Category;
}

export function seriesForChart(p: TutorProfile, limit = 20): ChartSeries[] {
  const recent = p.sessions.slice(-limit);
  return CATEGORIES.map((category) => ({
    category,
    points: recent.map((s) => ({ id: s.id, at: s.at, topic: s.topic, value: s.ratings[category] })),
  }));
}

export interface Recurring {
  skill: Skill;
  label: string;
  count: number; // sessions in the window showing it
  window: number;
  status: 'improving' | 'persisting' | 'not_enough_evidence';
  practice: { challenges: number; attempts: number; bestMet: number; bestTotal: number } | null;
}

// A weakness is recurring when it appears in at least 2 of the last 5 rated
// sessions. Its status compares the latest rated session against that pattern.
export function recurringWeaknesses(p: TutorProfile, windowSize = 5): Recurring[] {
  const rated = p.sessions.filter((s) => CATEGORIES.some((c) => s.ratings[c] !== null));
  const win = rated.slice(-windowSize);
  if (win.length < 2) return [];
  const latest = win[win.length - 1];
  const counts = new Map<Skill, number>();
  for (const s of win) for (const k of new Set(s.weaknesses)) counts.set(k, (counts.get(k) || 0) + 1);
  const out: Recurring[] = [];
  for (const [skill, count] of counts) {
    if (count < 2) continue;
    const cat = SKILLS[skill].category;
    const status: Recurring['status'] = latest.ratings[cat] === null
      ? 'not_enough_evidence'
      : latest.weaknesses.includes(skill) ? 'persisting' : 'improving';
    const chs = p.challenges.filter((c) => c.skill === skill);
    const attempts = chs.flatMap((c) => c.attempts);
    const best = attempts.reduce<Attempt | null>((b, a) => (!b || a.met / a.total > b.met / b.total ? a : b), null);
    out.push({
      skill,
      label: SKILLS[skill].label,
      count,
      window: win.length,
      status,
      practice: chs.length ? { challenges: chs.length, attempts: attempts.length, bestMet: best?.met || 0, bestTotal: best?.total || 0 } : null,
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.status === 'persisting' ? -1 : 1));
}

// Rating of the challenge's category in the session that triggered it vs. each attempt.
export function practiceEffect(p: TutorProfile, c: Challenge): { before: number | null; attempts: { at: string; rating: number | null; met: number; total: number }[] } {
  const cat = SKILLS[c.skill].category;
  const by = new Map(p.sessions.map((s) => [s.id, s]));
  return {
    before: by.get(c.fromSessionId)?.ratings[cat] ?? null,
    attempts: c.attempts.map((a) => ({ at: a.at, rating: by.get(a.sessionId)?.ratings[cat] ?? null, met: a.met, total: a.total })),
  };
}

// Compact history the coach reads (the current session excluded).
export function historyForCoach(p: TutorProfile, excludeId: string, limit = 8) {
  return {
    sessions: p.sessions.filter((s) => s.id !== excludeId).slice(-limit).map((s) => ({
      id: s.id, at: s.at, topic: s.topic, levelId: s.levelId, ratings: s.ratings, weaknesses: s.weaknesses,
      focusSkill: s.focusSkill, challengeId: s.challengeId, metrics: s.metrics,
    })),
    challenges: p.challenges.slice(-6),
    currentChallengeId: p.currentChallengeId,
  };
}
export type CoachHistory = ReturnType<typeof historyForCoach>;
