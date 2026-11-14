// Teaching performance ratings: three categories, 1-5, computed by fixed,
// deterministic rules from session evidence so scores are consistent across
// sessions. Each rating has one short explanation and the evidence behind it,
// or "Not enough evidence" when the session doesn't justify a rating.
//
// Principles: more talking or more questions is never rewarded by count;
// accents, pauses and speaking style are never penalized; pace and fillers
// only count when they were actually measured; a student "learning" only counts
// when it demonstrated understanding.

import type { KnowledgeEvent, LevelId, Segment, SpeechMetrics, StudentModel } from '../student/types.ts';
import type { EvidenceItem } from '../student/evidence.ts';
import { detectTeacherQuestion } from '../student/turns.ts';
import { fmt } from '../student/speech.ts';

export type Category = 'engagement' | 'communication' | 'teaching';
export const CATEGORIES: Category[] = ['engagement', 'communication', 'teaching'];
export const CATEGORY_LABEL: Record<Category, string> = {
  engagement: 'Engagement',
  communication: 'Communication',
  teaching: 'Teaching effectiveness',
};

export type Skill =
  | 'checking_understanding'
  | 'responding_to_questions'
  | 'student_participation'
  | 'clear_language'
  | 'clarity_and_pacing'
  | 'accuracy'
  | 'addressing_misconceptions'
  | 'building_understanding';

export const SKILLS: Record<Skill, { label: string; category: Category }> = {
  checking_understanding: { label: 'Checking for understanding', category: 'engagement' },
  responding_to_questions: { label: "Answering the student's questions", category: 'engagement' },
  student_participation: { label: 'Letting the student participate', category: 'engagement' },
  clear_language: { label: 'Explaining terms in plain language', category: 'communication' },
  clarity_and_pacing: { label: 'Clear, well-paced explanations', category: 'communication' },
  accuracy: { label: 'Conceptual accuracy', category: 'teaching' },
  addressing_misconceptions: { label: 'Addressing misconceptions', category: 'teaching' },
  building_understanding: { label: 'Getting the student to show understanding', category: 'teaching' },
};
export const SKILL_IDS = Object.keys(SKILLS) as Skill[];

// Shown in the UI ("How ratings work") so users know exactly what each number means.
export const RUBRIC_TEXT: Record<Category, string> = {
  engagement:
    'Starts at 3. +1 if you invited the student to think or checked understanding at least once. +1 if you answered at least 3 in 4 of its questions; −1 if fewer than half. −1 for a 90-second stretch with no check-in. −1 if the student had no chance to take part.',
  communication:
    'Starts at 4. −1 per term used without explaining it (max −2). −1 for an unclear or over-level explanation (−2 for three or more). −1 for very frequent fillers or a pace far above what the student can follow, only when measured. +1 if everything you explained was clear and jargon-free.',
  teaching:
    'Starts at 3. −1 per inaccurate explanation (max −2). +1 if the student correctly explained or applied a concept itself. +1 if you resolved a misconception; −1 if one it voiced was left standing. −1 if no concept was actually explained. Capped at 4 unless the student demonstrated understanding.',
};

export interface Factor {
  delta: number;
  text: string; // one short sentence, specific to this session
  skill: Skill | null; // the skill a negative factor points to
  evidenceIds: string[];
}

export interface Rating {
  category: Category;
  score: number | null; // null = not enough evidence
  explanation: string;
  factors: Factor[];
  evidenceIds: string[];
}

export type Scores = Record<Category, Rating>;

// Everything the rubric looks at, pulled from a saved session.
export interface SessionFacts {
  levelId: LevelId;
  teacherWords: number;
  teacherSpeakingSec: number;
  studentTurns: number;
  invitations: number; // check-ins + questions the tutor asked the student
  studentQuestions: number;
  answered: number;
  partlyAnswered: number;
  longRuns: number;
  undefinedTerms: number;
  unclear: number;
  incorrect: number;
  conceptsMentioned: number;
  conceptsExplained: number;
  demonstrated: number;
  demoAttempts: number;
  misconceptionsResolved: number;
  misconceptionsLeftStanding: number; // voiced by the student and still believed
  examples: number;
  wpm: number | null;
  fillersPerMin: number | null;
  maxRunSec: number | null;
}

export interface ScorableSession {
  levelId: LevelId;
  utterances: Segment[];
  events: KnowledgeEvent[];
  metrics: SpeechMetrics | null;
  evidence: EvidenceItem[];
  finalModel: StudentModel | null;
}

const MIN_WORDS = 40;
const FAST_WPM: Record<LevelId, number> = { kindergarten: 160, middle: 175, high: 190, college: 200, expert: 210 };

export function factsFrom(s: ScorableSession): SessionFacts {
  const teacher = (s.utterances || []).filter((u) => u.speaker === 'teacher');
  const words = teacher.reduce((n, u) => n + (u.text.trim() ? u.text.trim().split(/\s+/).length : 0), 0);
  const m = s.metrics;
  const ev = s.evidence || [];
  const count = (k: string) => ev.filter((e) => e.kind === k).length;
  const events = s.events || [];
  const evCount = (t: KnowledgeEvent['type']) => events.filter((e) => e.type === t).length;
  const asked = teacher.filter((u) => detectTeacherQuestion(u.text)).length;
  const checks = m?.checksForUnderstanding.length || 0;
  const model = s.finalModel;
  const qs = model?.questions || [];
  const spokeSec = m?.teacherSpeakingSec || 0;
  return {
    levelId: s.levelId,
    teacherWords: words,
    teacherSpeakingSec: spokeSec,
    studentTurns: (s.utterances || []).filter((u) => u.speaker === 'student').length,
    invitations: Math.max(checks, asked),
    studentQuestions: qs.length,
    answered: qs.filter((q) => q.status === 'answered').length,
    partlyAnswered: qs.filter((q) => q.status === 'partially_answered').length,
    longRuns: count('long_run'),
    undefinedTerms: evCount('undefined_term'),
    unclear: evCount('unclear_explanation'),
    incorrect: evCount('incorrect_explanation'),
    conceptsMentioned: model ? model.concepts.filter((c) => c.mentioned).length : 0,
    conceptsExplained: model ? model.concepts.filter((c) => c.explained).length : 0,
    demonstrated: model ? model.concepts.filter((c) => c.verification === 'demonstrated').length : 0,
    demoAttempts: evCount('demonstration'),
    misconceptionsResolved: model ? model.misconceptions.filter((x) => x.status === 'resolved').length : 0,
    misconceptionsLeftStanding: model ? model.misconceptions.filter((x) => x.expressed && x.status !== 'resolved').length : 0,
    examples: evCount('used_example'),
    wpm: m?.wordsPerMinute ?? null,
    fillersPerMin: m && spokeSec >= 30 ? Math.round((m.fillerCount / (spokeSec / 60)) * 10) / 10 : null,
    maxRunSec: m?.longestRun && spokeSec > 0 ? Math.round(m.longestRun.seconds) : null,
  };
}

const ids = (ev: EvidenceItem[], ...kinds: string[]) => ev.filter((e) => kinds.includes(e.kind)).map((e) => e.id);
const firstAt = (ev: EvidenceItem[], ...kinds: string[]) => {
  const e = ev.find((x) => kinds.includes(x.kind) && x.at !== null);
  return e ? ` (${fmt(e.at!)})` : '';
};
const clamp = (n: number) => Math.max(1, Math.min(5, n));

function finish(category: Category, base: number, factors: Factor[], cap = 5): Rating {
  const raw = factors.reduce((n, f) => n + f.delta, base);
  const score = Math.min(cap, clamp(raw));
  // The explanation names the factor that mattered most for this score.
  const negatives = factors.filter((f) => f.delta < 0).sort((a, b) => a.delta - b.delta);
  const positives = factors.filter((f) => f.delta > 0).sort((a, b) => b.delta - a.delta);
  let explanation: string;
  if (score <= 3 && negatives.length) explanation = negatives[0].text;
  else if (positives.length) explanation = positives[0].text + (negatives.length ? ` But: ${lowerFirst(negatives[0].text)}` : '');
  else if (negatives.length) explanation = negatives[0].text;
  else explanation = 'Nothing stood out either way in this session.';
  if (cap < 5 && raw > cap) explanation += ' Capped: the student never showed it understood.';
  return { category, score, explanation, factors, evidenceIds: [...new Set(factors.flatMap((f) => f.evidenceIds))] };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const notEnough = (category: Category, why: string): Rating => ({ category, score: null, explanation: `Not enough evidence: ${why}`, factors: [], evidenceIds: [] });

export function scoreEngagement(f: SessionFacts, ev: EvidenceItem[]): Rating {
  if (f.teacherWords < MIN_WORDS) return notEnough('engagement', 'the session was too short to judge.');
  const factors: Factor[] = [];
  if (f.invitations >= 1) factors.push({ delta: 1, text: 'You invited the student to think or checked its understanding.', skill: null, evidenceIds: ids(ev, 'checked_understanding') });
  if (f.studentQuestions >= 1) {
    const ratio = (f.answered + 0.5 * f.partlyAnswered) / f.studentQuestions;
    if (ratio >= 0.75) factors.push({ delta: 1, text: `You answered the student's questions (${f.answered} of ${f.studentQuestions} fully).`, skill: null, evidenceIds: ids(ev, 'question_answered') });
    else if (ratio < 0.5) factors.push({ delta: -1, text: `You left most of the student's questions unanswered (${f.answered} of ${f.studentQuestions} answered)${firstAt(ev, 'question_unanswered')}.`, skill: 'responding_to_questions', evidenceIds: ids(ev, 'question_unanswered', 'question_partial') });
  }
  if (f.longRuns >= 1) factors.push({ delta: -1, text: `You talked for over 90 seconds without checking in${firstAt(ev, 'long_run')}.`, skill: 'student_participation', evidenceIds: ids(ev, 'long_run') });
  if (f.studentTurns === 0 && f.invitations === 0) factors.push({ delta: -1, text: 'The student never got a chance to take part.', skill: 'student_participation', evidenceIds: [] });
  if (f.invitations === 0 && f.teacherWords >= 120) factors.push({ delta: 0, text: 'You never checked whether the student understood.', skill: 'checking_understanding', evidenceIds: ids(ev, 'no_checks') });
  return finish('engagement', 3, factors);
}

export function scoreCommunication(f: SessionFacts, ev: EvidenceItem[]): Rating {
  if (f.teacherWords < MIN_WORDS) return notEnough('communication', 'the session was too short to judge.');
  const factors: Factor[] = [];
  if (f.undefinedTerms > 0) {
    factors.push({ delta: -Math.min(2, f.undefinedTerms), text: `You used ${f.undefinedTerms === 1 ? 'a term' : `${f.undefinedTerms} terms`} without explaining ${f.undefinedTerms === 1 ? 'it' : 'them'}${firstAt(ev, 'undefined_term')}.`, skill: 'clear_language', evidenceIds: ids(ev, 'undefined_term') });
  }
  if (f.unclear > 0) {
    factors.push({ delta: f.unclear >= 3 ? -2 : -1, text: `${f.unclear === 1 ? 'One explanation was' : `${f.unclear} explanations were`} hard for this student to follow${firstAt(ev, 'unclear_explanation')}.`, skill: 'clarity_and_pacing', evidenceIds: ids(ev, 'unclear_explanation') });
  }
  if (f.fillersPerMin !== null && f.fillersPerMin >= 8) {
    factors.push({ delta: -1, text: `Fillers came up often (about ${f.fillersPerMin} per minute of speech).`, skill: 'clarity_and_pacing', evidenceIds: [] });
  }
  if (f.wpm !== null && f.wpm > FAST_WPM[f.levelId]) {
    factors.push({ delta: -1, text: `Your pace (about ${f.wpm} words per minute) was fast for this student.`, skill: 'clarity_and_pacing', evidenceIds: ids(ev, 'pace') });
  }
  if (f.undefinedTerms === 0 && f.unclear === 0 && f.conceptsExplained >= 1) {
    factors.push({ delta: 1, text: 'Your explanations were clear and free of unexplained jargon.', skill: null, evidenceIds: [] });
  }
  return finish('communication', 4, factors);
}

export function scoreTeaching(f: SessionFacts, ev: EvidenceItem[]): Rating {
  if (f.teacherWords < MIN_WORDS) return notEnough('teaching', 'the session was too short to judge.');
  if (f.conceptsMentioned === 0 && f.conceptsExplained === 0 && f.demoAttempts === 0) {
    return notEnough('teaching', "the session didn't get to the topic's key concepts.");
  }
  const factors: Factor[] = [];
  if (f.incorrect > 0) factors.push({ delta: -Math.min(2, f.incorrect), text: `Part of your explanation didn't match the material${firstAt(ev, 'incorrect_explanation')}.`, skill: 'accuracy', evidenceIds: ids(ev, 'incorrect_explanation') });
  if (f.demonstrated >= 1) factors.push({ delta: 1, text: 'The student explained or applied a concept correctly on its own.', skill: null, evidenceIds: ids(ev, 'demonstrated') });
  if (f.misconceptionsResolved >= 1) factors.push({ delta: 1, text: "You corrected the student's misconception and it stuck.", skill: null, evidenceIds: ids(ev, 'misconception_resolved') });
  if (f.misconceptionsLeftStanding >= 1) factors.push({ delta: -1, text: `The student voiced a misconception that was never corrected${firstAt(ev, 'misconception_unaddressed')}.`, skill: 'addressing_misconceptions', evidenceIds: ids(ev, 'misconception_unaddressed', 'misconception_partial') });
  if (f.conceptsExplained === 0) factors.push({ delta: -1, text: 'No key concept was actually explained, only mentioned.', skill: 'building_understanding', evidenceIds: [] });
  if (f.demonstrated === 0 && f.conceptsExplained >= 1) {
    const failed = ev.some((e) => e.kind === 'demo_failed' || e.kind === 'demo_partial');
    factors.push({ delta: 0, text: failed ? "When the student tried to explain it back, it didn't get it right." : 'The student never showed it understood (explained back or applied it).', skill: 'building_understanding', evidenceIds: ids(ev, 'demo_failed', 'demo_partial') });
  }
  if (f.examples >= 1 && f.incorrect === 0) factors.push({ delta: 1, text: 'You used a concrete example.', skill: null, evidenceIds: ids(ev, 'used_example') });
  return finish('teaching', 3, factors, f.demonstrated >= 1 ? 5 : 4);
}

export function scoreSession(s: ScorableSession): Scores {
  const f = factsFrom(s);
  const ev = s.evidence || [];
  return { engagement: scoreEngagement(f, ev), communication: scoreCommunication(f, ev), teaching: scoreTeaching(f, ev) };
}

// Skills this session showed weakness in, most severe first.
export function weaknesses(scores: Scores): { skill: Skill; severity: number; text: string }[] {
  const out = new Map<Skill, { skill: Skill; severity: number; text: string; top: number }>();
  for (const c of CATEGORIES) {
    for (const f of scores[c].factors) {
      if (!f.skill || f.delta > 0) continue;
      const sev = -f.delta + 0.5; // zero-delta findings still count, a little
      const prev = out.get(f.skill);
      if (!prev) out.set(f.skill, { skill: f.skill, severity: sev, text: f.text, top: sev });
      else {
        prev.severity += sev;
        if (sev > prev.top) Object.assign(prev, { text: f.text, top: sev });
      }
    }
  }
  return [...out.values()]
    .sort((a, b) => b.severity - a.severity || SKILL_IDS.indexOf(a.skill) - SKILL_IDS.indexOf(b.skill))
    .map(({ skill, severity, text }) => ({ skill, severity, text }));
}
