// Teach to Learn progress, kept apart from Learn to Teach progress. Stores
// what was studied and what the user showed (or didn't show) they understand.
// One short session is evidence about that session, not proof of mastery, so
// nothing here is turned into a score.

import type { LevelId } from '../student/types.ts';
import { understandingOf } from '../learner/tracker.ts';
import type { Understanding } from '../learner/types.ts';
import type { Practice, StudyPlan, StudyRecord } from './types.ts';

export const STUDY_PROGRESS_KEY = 'teach2learn-study-v1';
export const STUDY_HISTORY_KEY = 'teach2learn-study-history-v1';
export const MAX_STUDY_SESSIONS = 100;
export const MAX_STUDY_RECORDS = 20;

export interface StudySummary {
  id: string;
  at: string;
  topic: string;
  topicKey: string;
  levelId: LevelId;
  concepts: { id: string; name: string; understanding: Understanding }[];
  gaps: string[]; // not covered or not verified
  misconceptions: { name: string; quote: string }[];
  reviewNext: { name: string; text: string } | null;
  whiteboard: { count: number; notes: string[] };
  practiceId: string | null; // practice this session attempted
}

export interface StudyProfile {
  version: 1;
  sessions: StudySummary[]; // oldest first
  practice: Practice[]; // oldest first
  currentPracticeId: string | null;
  note: string; // planner's note to itself
  lastLog: { sessionId: string; agent: string; error?: string; log: StudyPlan['log'] } | null;
}

export const emptyStudyProfile = (): StudyProfile => ({ version: 1, sessions: [], practice: [], currentPracticeId: null, note: '', lastLog: null });

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage);

export function loadStudyProfile(store: Store | null = defaultStore()): StudyProfile {
  if (!store) return emptyStudyProfile();
  try {
    const raw = JSON.parse(store.getItem(STUDY_PROGRESS_KEY) || 'null');
    if (!raw || raw.version !== 1 || !Array.isArray(raw.sessions)) return emptyStudyProfile();
    return {
      version: 1,
      sessions: raw.sessions.filter((s: any) => s?.id && s?.at && Array.isArray(s.concepts)),
      practice: (raw.practice || []).filter((p: any) => p?.id && p?.prompt && Array.isArray(p.attempts)),
      currentPracticeId: typeof raw.currentPracticeId === 'string' ? raw.currentPracticeId : null,
      note: typeof raw.note === 'string' ? raw.note : '',
      lastLog: raw.lastLog || null,
    };
  } catch {
    return emptyStudyProfile();
  }
}

function saveTrimmed<T>(store: Store | null, key: string, build: (n: number) => T, total: number): boolean {
  if (!store) return false;
  let keep = total;
  for (;;) {
    try {
      store.setItem(key, JSON.stringify(build(keep)));
      return true;
    } catch {
      if (keep <= 1) return false;
      keep = Math.floor(keep * 0.75); // drop the oldest quarter and retry
    }
  }
}

export function saveStudyProfile(p: StudyProfile, store: Store | null = defaultStore()): boolean {
  const sessions = p.sessions.slice(-MAX_STUDY_SESSIONS);
  return saveTrimmed(store, STUDY_PROGRESS_KEY, (n) => ({ ...p, sessions: sessions.slice(-n) }), sessions.length || 1);
}

// Full records (transcript, checklist, feedback, small whiteboard thumbnails).
export function loadStudyHistory(store: Store | null = defaultStore()): StudyRecord[] {
  if (!store) return [];
  try {
    const raw = JSON.parse(store.getItem(STUDY_HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((r) => r?.version === 'study1' && r.learner && r.feedback) : [];
  } catch {
    return [];
  }
}

export function saveStudyHistory(records: StudyRecord[], store: Store | null = defaultStore()): boolean {
  const list = records.slice(0, MAX_STUDY_RECORDS); // newest first
  // If storage is tight, thumbnails go first, then the oldest records.
  if (!store) return false;
  try {
    store.setItem(STUDY_HISTORY_KEY, JSON.stringify(list));
    return true;
  } catch {}
  const noThumbs = list.map((r) => ({ ...r, boards: r.boards.map(({ thumb, ...b }) => b) }));
  return saveTrimmed(store, STUDY_HISTORY_KEY, (n) => noThumbs.slice(0, n), noThumbs.length || 1);
}

// ---- Summaries ------------------------------------------------------------------

export function summarizeStudy(r: StudyRecord): StudySummary {
  const concepts = r.learner.concepts.map((c) => ({ id: c.id, name: c.name, understanding: understandingOf(c) }));
  return {
    id: r.id,
    at: r.createdAt,
    topic: r.topicTitle,
    topicKey: r.topicKey,
    levelId: r.levelId,
    concepts,
    gaps: concepts.filter((c) => c.understanding !== 'demonstrated').map((c) => c.name),
    misconceptions: (r.feedback?.misconceptions || []).map((m) => ({ name: m.name, quote: m.quote })),
    reviewNext: r.feedback?.reviewNext ? { name: r.feedback.reviewNext.name, text: r.feedback.reviewNext.text } : null,
    whiteboard: { count: r.boards.filter((b) => !b.blank).length, notes: r.boards.filter((b) => !b.blank).map((b) => (b.transcription || b.description).slice(0, 80)).slice(-3) },
    practiceId: r.practiceId,
  };
}

export function addStudySession(p: StudyProfile, s: StudySummary): StudyProfile {
  return { ...p, sessions: p.sessions.filter((x) => x.id !== s.id).concat(s).sort((a, b) => a.at.localeCompare(b.at)) };
}

export const currentPractice = (p: StudyProfile): Practice | null => p.practice.find((x) => x.id === p.currentPracticeId && x.status === 'open') || null;

export function applyStudyPlan(p: StudyProfile, plan: StudyPlan): StudyProfile {
  const practice = p.practice.map((x) => ({ ...x, attempts: [...x.attempts] }));
  if (plan.practiceOutcome) {
    const x = practice.find((y) => y.id === plan.practiceOutcome!.practiceId);
    if (x && !x.attempts.some((a) => a.sessionId === plan.sessionId)) {
      x.attempts.push({ sessionId: plan.sessionId, at: p.sessions.find((s) => s.id === plan.sessionId)?.at || new Date().toISOString(), understanding: plan.practiceOutcome.understanding });
      if (plan.practiceOutcome.understanding === 'demonstrated') x.status = 'done';
    }
  }
  let currentPracticeId = p.currentPracticeId;
  if (plan.practice) {
    if (!practice.some((x) => x.id === plan.practice!.id)) practice.push({ ...plan.practice, status: 'open' });
    currentPracticeId = plan.practice.id;
  }
  return { ...p, practice, currentPracticeId, note: plan.note || p.note, lastLog: { sessionId: plan.sessionId, agent: plan.agent, error: plan.error, log: plan.log } };
}

// ---- Views ------------------------------------------------------------------------

export interface TopicView {
  topicKey: string;
  topic: string;
  sessions: number;
  lastAt: string;
  lastSessionId: string;
  concepts: { name: string; latest: Understanding; history: Understanding[] }[];
  remaining: string[]; // latest status is not "demonstrated"
}

export function topicsView(p: StudyProfile): TopicView[] {
  const by = new Map<string, TopicView>();
  for (const s of p.sessions) {
    const t = by.get(s.topicKey) || { topicKey: s.topicKey, topic: s.topic, sessions: 0, lastAt: s.at, lastSessionId: s.id, concepts: [], remaining: [] };
    t.sessions += 1;
    t.lastAt = s.at;
    t.lastSessionId = s.id;
    t.topic = s.topic;
    for (const c of s.concepts) {
      let row = t.concepts.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      if (!row) t.concepts.push((row = { name: c.name, latest: c.understanding, history: [] }));
      row.history.push(c.understanding);
      row.latest = c.understanding;
    }
    by.set(s.topicKey, t);
  }
  for (const t of by.values()) t.remaining = t.concepts.filter((c) => c.latest !== 'demonstrated').map((c) => c.name);
  return [...by.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

// Concepts not demonstrated in 2+ sessions of the same topic, still not demonstrated.
export function recurringGaps(p: StudyProfile, topicKey: string, excludeId = ''): string[] {
  const sessions = p.sessions.filter((s) => s.topicKey === topicKey && s.id !== excludeId);
  const counts = new Map<string, { name: string; n: number; last: Understanding }>();
  for (const s of sessions) {
    for (const c of s.concepts) {
      const k = c.name.toLowerCase();
      const row = counts.get(k) || { name: c.name, n: 0, last: c.understanding };
      if (c.understanding !== 'demonstrated') row.n += 1;
      row.last = c.understanding;
      counts.set(k, row);
    }
  }
  return [...counts.values()].filter((r) => r.n >= 1 && r.last !== 'demonstrated').map((r) => r.name);
}

export function historyForPlanner(p: StudyProfile, excludeId: string, limit = 8) {
  return {
    sessions: p.sessions.filter((s) => s.id !== excludeId).slice(-limit),
    practice: p.practice.slice(-5),
    currentPracticeId: p.currentPracticeId,
  };
}
export type PlannerHistory = ReturnType<typeof historyForPlanner>;
