// Session persistence (localStorage). Saves each completed session as a
// versioned record. Older saves are migrated on load so they stay readable.
// Uploaded files are never saved.

import type { Extraction, KnowledgeEvent, LevelId, Segment, SpeechMetrics, StudentModel } from './student/types.ts';
import type { ConceptSummary, LearningSummary } from './student/knowledge.ts';
import type { EvidenceItem, FeedbackItem } from './student/evidence.ts';

export const KEY = 'teach2learn-history-v4';
export const LEGACY_KEYS = ['teach2learn-history-v3', 'teach2learn-history-v1'];
export const MAX_HISTORY = 50;

export interface Teaching {
  went_well: FeedbackItem | null;
  improve: FeedbackItem | null;
  try_next: FeedbackItem | null;
}

export interface SessionRecord {
  version: 4;
  id: string;
  createdAt: string;
  topicId: string;
  topicTitle: string;
  levelId: LevelId;
  timeLimitSec: number;
  timeUsedSec: number;
  extraction: Extraction | null;
  initialModel: StudentModel | null;
  finalModel: StudentModel | null;
  events: KnowledgeEvent[];
  utterances: Segment[];
  metrics: SpeechMetrics;
  learning: LearningSummary;
  concepts: ConceptSummary[]; // student learning (verification), kept apart from...
  teaching: Teaching; // ...teacher performance feedback
  evidence: EvidenceItem[];
  usedFallback: boolean;
  latencies: number[]; // ms from end of teacher speech to student audio
}

// Sessions saved by earlier versions of the app (rubric era and v3), kept readable.
export interface LegacyRecord {
  version: 1;
  id: string;
  createdAt: string;
  topicId: string;
  topicTitle: string;
  levelId: LevelId;
  timeLimitSec: number;
  timeUsedSec: number;
  transcript: string;
  summary: string;
  suggestions: string[];
  scorePercent: number | null;
}

export type AnyRecord = SessionRecord | LegacyRecord;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage);

const LEVEL_IDS = ['kindergarten', 'middle', 'high', 'college', 'expert'];

// Convert anything we find in storage to a current record, or null if unreadable.
export function migrate(raw: any): AnyRecord | null {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.createdAt) return null;
  const levelId = (LEVEL_IDS.includes(raw.levelId) ? raw.levelId : 'middle') as LevelId;
  if (raw.version === 4) {
    if (!raw.teaching || !Array.isArray(raw.utterances)) return null;
    return { ...raw, levelId } as SessionRecord;
  }
  // v3: knowledge-model sessions with long-form suggestions.
  if (raw.version === 3 && raw.feedback && Array.isArray(raw.utterances)) {
    return {
      version: 1,
      id: String(raw.id),
      createdAt: String(raw.createdAt),
      topicId: String(raw.topicId || raw.id),
      topicTitle: String(raw.topicTitle || 'Untitled lesson'),
      levelId,
      timeLimitSec: Number(raw.timeLimitSec) || 0,
      timeUsedSec: Number(raw.timeUsedSec) || 0,
      transcript: raw.utterances.map((u: any) => `${u.speaker === 'student' ? 'Student' : 'You'}: ${u.text}`).join('\n'),
      summary: String(raw.feedback.summary || ''),
      suggestions: (raw.feedback.suggestions || []).map((x: any) => `${x.title}: ${x.detail}`),
      scorePercent: null,
    };
  }
  // Already-migrated legacy record (saved back under the current key).
  if (raw.version === 1 && Array.isArray(raw.suggestions) && 'transcript' in raw) return { ...raw, levelId } as LegacyRecord;
  // v1: { planId, plan, session: { transcript, notes, timeUsedSec }, grade: { score, suggestions, summary } }
  if (raw.plan && raw.session && raw.grade) {
    return {
      version: 1,
      id: String(raw.id),
      createdAt: String(raw.createdAt),
      topicId: String(raw.planId || raw.id),
      topicTitle: String(raw.plan.topic_title || 'Untitled lesson'),
      levelId,
      timeLimitSec: Number(raw.timeLimitSec) || 0,
      timeUsedSec: Number(raw.session.timeUsedSec) || 0,
      transcript: String(raw.session.transcript || ''),
      summary: String(raw.grade.summary || ''),
      suggestions: (raw.grade.suggestions || []).map(String),
      scorePercent: typeof raw.grade.score?.percent === 'number' ? raw.grade.score.percent : null,
    };
  }
  return null;
}

function readKey(s: Store, key: string): AnyRecord[] {
  try {
    const list = JSON.parse(s.getItem(key) || '[]');
    return Array.isArray(list) ? list.map(migrate).filter((r): r is AnyRecord => !!r) : [];
  } catch {
    return [];
  }
}

export function loadHistory(): AnyRecord[] {
  const s = store();
  if (!s) return [];
  const byId = new Map<string, AnyRecord>();
  for (const key of [KEY, ...LEGACY_KEYS]) for (const r of readKey(s, key)) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Returns false if not everything fit; drops the oldest sessions until it does.
export function saveHistory(list: AnyRecord[]): boolean {
  const s = store();
  if (!s) return false;
  for (let n = list.length; n >= 0; n--) {
    try {
      s.setItem(KEY, JSON.stringify(list.slice(0, n)));
      // Legacy records now live under KEY; drop the old keys so deletes stick.
      for (const k of LEGACY_KEYS) s.removeItem(k);
      return n === list.length;
    } catch {
      // keep trimming
    }
  }
  return false;
}

export function attemptNumber(history: AnyRecord[], entry: AnyRecord): number {
  return history.filter((e) => e.topicId === entry.topicId && e.createdAt <= entry.createdAt).length;
}

// Keep saved records small: drop noisy debug events.
export function compactEvents(events: KnowledgeEvent[]): KnowledgeEvent[] {
  return events.filter((e) => e.type !== 'rejected_proposal').slice(-300);
}
