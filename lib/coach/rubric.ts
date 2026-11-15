// Learn to Teach ratings: three categories scored 0-100 by a fixed, weighted
// rubric of measurable criteria, plus a weighted overall score. Everything is
// computed by code from session evidence (never by a language model), so the
// same session always gets the same scores and sessions are comparable.
//
// Principles: talking more or asking more questions is not rewarded beyond what
// a criterion needs; accents, pauses and speaking style are never inputs; pace
// and fillers count only when measured; basic, age-appropriate vocabulary is
// never "jargon"; explaining is not learning (the student must show it); factual
// errors and shallow explanations (no "why", essential part missing) cost more
// than an unexplained term. Concise, accurate explanations get full marks.

import type { KnowledgeEvent, LevelId, Segment, SpeechMetrics, StudentModel } from '../student/types.ts';
import type { EvidenceItem } from '../student/evidence.ts';
import { detectTeacherQuestion } from '../student/turns.ts';
import { fmt } from '../student/speech.ts';

export const SCALE = 100;
export type Category = 'engagement' | 'communication' | 'teaching';
export const CATEGORIES: Category[] = ['engagement', 'communication', 'teaching'];
export const CATEGORY_LABEL: Record<Category, string> = {
  engagement: 'Engagement',
  communication: 'Communication',
  teaching: 'Teaching effectiveness',
};
// Overall = weighted combination. Teaching effectiveness counts most.
export const OVERALL_WEIGHTS: Record<Category, number> = { engagement: 0.3, communication: 0.3, teaching: 0.4 };

export type Skill =
  | 'checking_understanding'
  | 'responding_to_questions'
  | 'student_participation'
  | 'clear_language'
  | 'clarity_and_pacing'
  | 'accuracy'
  | 'explaining_reasoning'
  | 'covering_key_ideas'
  | 'addressing_misconceptions'
  | 'building_understanding';

export const SKILLS: Record<Skill, { label: string; category: Category }> = {
  checking_understanding: { label: 'Checking for understanding', category: 'engagement' },
  responding_to_questions: { label: "Answering the student's questions", category: 'engagement' },
  student_participation: { label: 'Letting the student participate', category: 'engagement' },
  clear_language: { label: 'Explaining terms in plain language', category: 'communication' },
  clarity_and_pacing: { label: 'Clear, well-ordered explanations', category: 'communication' },
  accuracy: { label: 'Conceptual accuracy', category: 'teaching' },
  explaining_reasoning: { label: 'Explaining the why, not just the what', category: 'teaching' },
  covering_key_ideas: { label: 'Covering the key ideas', category: 'teaching' },
  addressing_misconceptions: { label: 'Addressing misconceptions', category: 'teaching' },
  building_understanding: { label: 'Getting the student to show understanding', category: 'teaching' },
};
export const SKILL_IDS = Object.keys(SKILLS) as Skill[];

// ---- Session facts -----------------------------------------------------------------------

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
  undefinedTerms: number; // beyond the student's level only
  unclear: number;
  incorrect: number;
  accurate: number; // explanations judged accurate and essentially complete
  shallow: number; // accurate as far as they go, but missing the why or an essential part
  reinforced: number; // agreed with the student's wrong idea
  conceptsTotal: number;
  conceptsMentioned: number;
  conceptsExplained: number;
  orderedExplained: number; // explained after the ideas they build on
  orderable: number; // explained concepts that have prerequisites
  demonstrated: number;
  partlyDemonstrated: number;
  demoAttempts: number;
  misconceptionsResolved: number;
  misconceptionsVoiced: number;
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

export const MIN_WORDS = 40;
const FAST_WPM: Record<LevelId, number> = { kindergarten: 160, middle: 175, high: 190, college: 200, expert: 210 };

export function factsFrom(s: ScorableSession): SessionFacts {
  const teacher = (s.utterances || []).filter((u) => u.speaker === 'teacher' && u.source !== 'whiteboard');
  const words = teacher.reduce((n, u) => n + (u.text.trim() ? u.text.trim().split(/\s+/).length : 0), 0);
  const m = s.metrics;
  const ev = s.evidence || [];
  const events = s.events || [];
  const evCount = (t: KnowledgeEvent['type']) => events.filter((e) => e.type === t).length;
  const asked = teacher.filter((u) => detectTeacherQuestion(u.text)).length;
  const checks = m?.checksForUnderstanding.length || 0;
  const model = s.finalModel;
  const qs = model?.questions || [];
  const spokeSec = m?.teacherSpeakingSec || 0;
  // When was each concept first explained? (for "explained in a sensible order")
  const firstExplained = new Map<string, number>();
  for (const e of events) {
    if ((e.type === 'accurate_explanation' || e.type === 'shallow_explanation' || e.type === 'incorrect_explanation') && !firstExplained.has(e.conceptId)) firstExplained.set(e.conceptId, e.at);
  }
  let ordered = 0;
  let orderable = 0;
  for (const c of model?.concepts || []) {
    const at = firstExplained.get(c.id);
    if (at === undefined || !c.prerequisites.length) continue;
    orderable += 1;
    const ok = c.prerequisites.every((p) => {
      const pa = firstExplained.get(p);
      const pc = model!.concepts.find((x) => x.id === p);
      return (pa !== undefined && pa <= at) || (pc ? pc.initialMastery >= 50 : true); // known prerequisites need no explaining
    });
    if (ok) ordered += 1;
  }
  return {
    levelId: s.levelId,
    teacherWords: words,
    teacherSpeakingSec: spokeSec,
    studentTurns: (s.utterances || []).filter((u) => u.speaker === 'student').length,
    invitations: Math.max(checks, asked),
    studentQuestions: qs.length,
    answered: qs.filter((q) => q.status === 'answered').length,
    partlyAnswered: qs.filter((q) => q.status === 'partially_answered').length,
    longRuns: ev.filter((e) => e.kind === 'long_run').length,
    undefinedTerms: evCount('undefined_term'),
    unclear: evCount('unclear_explanation'),
    incorrect: evCount('incorrect_explanation'),
    accurate: evCount('accurate_explanation'),
    shallow: evCount('shallow_explanation'),
    reinforced: events.filter((e) => e.type === 'misconception_change' && e.to === 'active').length,
    conceptsTotal: model?.concepts.length || 0,
    conceptsMentioned: model ? model.concepts.filter((c) => c.mentioned).length : 0,
    conceptsExplained: model ? model.concepts.filter((c) => c.explained).length : 0,
    orderedExplained: ordered,
    orderable,
    demonstrated: model ? model.concepts.filter((c) => c.verification === 'demonstrated').length : 0,
    partlyDemonstrated: model ? model.concepts.filter((c) => c.verification === 'partial').length : 0,
    demoAttempts: evCount('demonstration'),
    misconceptionsResolved: model ? model.misconceptions.filter((x) => x.status === 'resolved').length : 0,
    misconceptionsVoiced: model ? model.misconceptions.filter((x) => x.expressed).length : 0,
    misconceptionsLeftStanding: model ? model.misconceptions.filter((x) => x.expressed && x.status !== 'resolved').length : 0,
    examples: evCount('used_example'),
    wpm: m?.wordsPerMinute ?? null,
    fillersPerMin: m && spokeSec >= 30 ? Math.round((m.fillerCount / (spokeSec / 60)) * 10) / 10 : null,
    maxRunSec: m?.longestRun && spokeSec > 0 ? Math.round(m.longestRun.seconds) : null,
  };
}

// ---- Criteria -------------------------------------------------------------------------------

export interface CriterionScore {
  id: string;
  category: Category;
  label: string;
  weight: number; // points within the category (weights sum to 100)
  value: number | null; // 0..1, or null when it can't be judged (weight redistributed)
  points: number | null; // earned points before redistribution
  detail: string; // what was measured, specific to this session
  skill: Skill;
  evidenceIds: string[];
}

// The fixed rubric. `measure` returns [value 0..1 | null, detail].
interface CriterionDef {
  id: string;
  category: Category;
  label: string;
  weight: number;
  skill: Skill;
  rule: string; // shown in "How ratings work"
  kinds: string[]; // evidence kinds that back it
  measure: (f: SessionFacts) => [number | null, string];
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const CRITERIA: CriterionDef[] = [
  // Engagement
  {
    id: 'E1', category: 'engagement', label: 'Checked understanding', weight: 25, skill: 'checking_understanding', kinds: ['checked_understanding', 'no_checks'],
    rule: 'Asked the student to think or checked understanding: 0 times = 0, once = 70%, twice or more = full. More is not rewarded.',
    measure: (f) => [f.invitations >= 2 ? 1 : f.invitations === 1 ? 0.7 : 0, f.invitations ? `Checked in or asked the student to think ${plural(f.invitations, 'time')}.` : 'Never checked whether the student understood.'],
  },
  {
    id: 'E2', category: 'engagement', label: "Answered the student's questions", weight: 35, skill: 'responding_to_questions', kinds: ['question_answered', 'question_partial', 'question_unanswered'],
    rule: "Share of the student's questions answered (a partial answer counts half). Not judged if it asked none.",
    measure: (f) => (f.studentQuestions ? [ratio(f.answered + 0.5 * f.partlyAnswered, f.studentQuestions), `Answered ${f.answered} of ${plural(f.studentQuestions, 'question')} fully${f.partlyAnswered ? `, ${f.partlyAnswered} partly` : ''}.`] : [null, 'The student asked no questions.']),
  },
  {
    id: 'E3', category: 'engagement', label: 'Let the student take part', weight: 25, skill: 'student_participation', kinds: ['long_run'],
    rule: 'Longest stretch without letting the student in: up to 60s = full, 60-90s = 60%, over 90s = 20%; the student never speaking = 0. Only when timed.',
    measure: (f) => {
      if (f.studentTurns === 0 && f.invitations === 0) return [0, 'The student never got a chance to take part.'];
      if (f.maxRunSec === null) return [null, 'Talk stretches were not timed.'];
      const v = f.longRuns > 0 || f.maxRunSec > 90 ? 0.2 : f.maxRunSec > 60 ? 0.6 : 1;
      return [v, `Longest stretch without the student: ${f.maxRunSec}s.`];
    },
  },
  {
    id: 'E4', category: 'engagement', label: 'Responded to wrong ideas', weight: 15, skill: 'addressing_misconceptions', kinds: ['misconception_resolved', 'misconception_unaddressed'],
    rule: 'Share of the wrong ideas the student voiced that were resolved. Not judged if it voiced none.',
    measure: (f) => (f.misconceptionsVoiced ? [ratio(f.misconceptionsVoiced - f.misconceptionsLeftStanding, f.misconceptionsVoiced), `${f.misconceptionsVoiced - f.misconceptionsLeftStanding} of ${plural(f.misconceptionsVoiced, 'wrong idea')} the student voiced were resolved.`] : [null, 'The student voiced no wrong ideas.']),
  },
  // Communication
  {
    id: 'C1', category: 'communication', label: 'Clear explanations', weight: 40, skill: 'clarity_and_pacing', kinds: ['unclear_explanation'],
    rule: 'Share of explanations this student could follow (unclear or over-level ones count against it).',
    measure: (f) => {
      const n = f.accurate + f.shallow + f.incorrect;
      if (!n) return [null, 'Nothing was explained yet.'];
      return [Math.max(0, 1 - ratio(f.unclear, n)), f.unclear ? `${plural(f.unclear, 'explanation')} of ${n} were hard for this student to follow.` : `All ${plural(n, 'explanation')} were clear for this student.`];
    },
  },
  {
    id: 'C2', category: 'communication', label: 'Level-appropriate language', weight: 25, skill: 'clear_language', kinds: ['undefined_term'],
    rule: 'Terms beyond the student\'s level used without explaining them: none = full, then 80%, 60%, 40% (basic, age-appropriate words never count).',
    measure: (f) => [[1, 0.8, 0.6][f.undefinedTerms] ?? 0.4, f.undefinedTerms ? `Used ${plural(f.undefinedTerms, 'term')} beyond this student's level without explaining ${f.undefinedTerms === 1 ? 'it' : 'them'}.` : 'No unexplained terms beyond the student\'s level.'],
  },
  {
    id: 'C3', category: 'communication', label: 'Logical order', weight: 20, skill: 'clarity_and_pacing', kinds: [],
    rule: 'Share of explained ideas that came after the ideas they build on (or that the student already knew). Not judged with fewer than one such idea.',
    measure: (f) => (f.orderable ? [ratio(f.orderedExplained, f.orderable), `${f.orderedExplained} of ${plural(f.orderable, 'idea')} that build on others came in a sensible order.`] : [null, 'No ideas that depend on others were explained.']),
  },
  {
    id: 'C4', category: 'communication', label: 'Pace and fluency (measured)', weight: 15, skill: 'clarity_and_pacing', kinds: ['pace'],
    rule: 'Only when measured: −50% for a pace far above what this student can follow, −50% for fillers at 8+ per minute. Pauses and accent never count.',
    measure: (f) => {
      if (f.wpm === null && f.fillersPerMin === null) return [null, 'Pace was not measured.'];
      const fast = f.wpm !== null && f.wpm > FAST_WPM[f.levelId];
      const fillers = f.fillersPerMin !== null && f.fillersPerMin >= 8;
      return [1 - (fast ? 0.5 : 0) - (fillers ? 0.5 : 0), fast || fillers ? [fast && `about ${f.wpm} words per minute, fast for this student`, fillers && `about ${f.fillersPerMin} fillers per minute`].filter(Boolean).join('; ') + '.' : 'Pace and fluency were comfortable for this student.'];
    },
  },
  // Teaching effectiveness
  {
    id: 'T1', category: 'teaching', label: 'Accuracy', weight: 30, skill: 'accuracy', kinds: ['incorrect_explanation'],
    rule: 'Each factual error (or agreeing with the student\'s wrong idea) costs 40% of this criterion.',
    measure: (f) => {
      const errs = f.incorrect + f.reinforced;
      if (!f.conceptsMentioned && !errs) return [null, 'No concept was discussed.'];
      return [Math.max(0, 1 - 0.4 * errs), errs ? `${plural(errs, 'statement')} didn't match the material.` : 'Everything explained matched the material.'];
    },
  },
  {
    id: 'T2', category: 'teaching', label: 'Explained the why', weight: 25, skill: 'explaining_reasoning', kinds: ['accurate_explanation', 'shallow_explanation'],
    rule: 'Share of accurate explanations that covered the essential idea and the reason behind it (concise is fine; extra length earns nothing).',
    measure: (f) => {
      const n = f.accurate + f.shallow;
      if (!n) return [f.conceptsMentioned ? 0 : null, f.conceptsMentioned ? 'Ideas were mentioned but never accurately explained.' : 'No concept was discussed.'];
      return [ratio(f.accurate, n), f.shallow ? `${f.accurate} of ${plural(n, 'explanation')} covered the essentials; ${f.shallow} left out the why or an essential part.` : `All ${plural(n, 'explanation')} covered the essential idea.`];
    },
  },
  {
    id: 'T3', category: 'teaching', label: 'Covered the key ideas', weight: 15, skill: 'covering_key_ideas', kinds: ['not_covered'],
    rule: 'Share of the topic\'s key concepts actually explained (not just mentioned).',
    measure: (f) => (f.conceptsTotal ? [ratio(f.conceptsExplained, f.conceptsTotal), `Explained ${f.conceptsExplained} of ${plural(f.conceptsTotal, 'key concept')}.`] : [null, 'No key concepts were prepared.']),
  },
  {
    id: 'T4', category: 'teaching', label: 'Student showed understanding', weight: 20, skill: 'building_understanding', kinds: ['demonstrated', 'demo_partial', 'demo_failed'],
    rule: 'The student explained or applied an idea correctly: one concept = 70%, plus up to 30% for the share of explained concepts it demonstrated; only partly = 35%; never = 0.',
    measure: (f) => {
      if (!f.conceptsExplained && !f.demoAttempts) return [0, 'Nothing was explained, so the student had nothing to show.'];
      if (f.demonstrated) return [Math.min(1, 0.7 + 0.3 * ratio(f.demonstrated, Math.max(1, f.conceptsExplained))), `The student showed it understood ${plural(f.demonstrated, 'concept')}.`];
      if (f.partlyDemonstrated) return [0.35, 'The student only partly showed it understood.'];
      return [0, f.demoAttempts ? "When the student tried to explain it back, it didn't get it right." : 'The student never showed it understood (explained back or applied it).'];
    },
  },
  {
    id: 'T5', category: 'teaching', label: 'Fixed wrong ideas', weight: 10, skill: 'addressing_misconceptions', kinds: ['misconception_resolved', 'misconception_unaddressed', 'misconception_partial'],
    rule: 'A wrong idea the student voiced and kept costs this criterion; resolving one earns it. Not judged if none came up.',
    measure: (f) => {
      if (!f.misconceptionsVoiced && !f.misconceptionsResolved) return [null, 'No wrong ideas came up.'];
      return [ratio(f.misconceptionsResolved, Math.max(f.misconceptionsResolved, f.misconceptionsVoiced)), f.misconceptionsLeftStanding ? `${plural(f.misconceptionsLeftStanding, 'wrong idea')} the student voiced ${f.misconceptionsLeftStanding === 1 ? 'was' : 'were'} never corrected.` : `Resolved ${plural(f.misconceptionsResolved, 'wrong idea')}.`];
    },
  },
];

export const RUBRIC_TEXT: Record<Category, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c, CRITERIA.filter((x) => x.category === c).map((x) => `${x.label} (${x.weight} pts): ${x.rule}`).join(' ')]),
) as Record<Category, string>;

// ---- Scoring --------------------------------------------------------------------------------

export interface Factor {
  delta: number; // points lost (<= 0) on the 0-100 scale, after redistribution
  text: string;
  skill: Skill | null;
  evidenceIds: string[];
}

export interface Rating {
  category: Category;
  score: number | null; // 0-100, null = not enough evidence
  explanation: string;
  criteria: CriterionScore[];
  factors: Factor[]; // lost points per criterion, for the coach and the UI
  evidenceIds: string[];
}

export type Scores = Record<Category, Rating> & { overall: number | null; scale: 100 };

const MIN_JUDGED_WEIGHT = 40; // below this much judgeable weight, a category isn't rated

const ids = (ev: EvidenceItem[], kinds: string[]) => ev.filter((e) => kinds.includes(e.kind)).map((e) => e.id);
const firstAt = (ev: EvidenceItem[], kinds: string[]) => {
  const e = ev.find((x) => kinds.includes(x.kind) && x.at !== null);
  return e ? ` (${fmt(e.at!)})` : '';
};

const notEnough = (category: Category, why: string, criteria: CriterionScore[] = []): Rating => ({ category, score: null, explanation: `Not enough evidence: ${why}`, criteria, factors: [], evidenceIds: [] });

export function scoreCategory(category: Category, f: SessionFacts, ev: EvidenceItem[]): Rating {
  const criteria: CriterionScore[] = CRITERIA.filter((c) => c.category === category).map((d) => {
    const [value, detail] = d.measure(f);
    const v = value === null ? null : Math.max(0, Math.min(1, value));
    const lostAt = v !== null && v < 1 ? firstAt(ev, d.kinds) : '';
    return { id: d.id, category, label: d.label, weight: d.weight, value: v, points: v === null ? null : Math.round(v * d.weight * 10) / 10, detail: detail.replace(/\.$/, '') + lostAt + '.', skill: d.skill, evidenceIds: ids(ev, d.kinds) };
  });
  if (f.teacherWords < MIN_WORDS) return notEnough(category, 'the session was too short to judge.', criteria);
  if (category === 'teaching' && f.conceptsMentioned === 0 && f.conceptsExplained === 0 && f.demoAttempts === 0) {
    return notEnough(category, "the session didn't get to the topic's key concepts.", criteria);
  }
  const judged = criteria.filter((c) => c.value !== null);
  const judgedWeight = judged.reduce((n, c) => n + c.weight, 0);
  if (judgedWeight < MIN_JUDGED_WEIGHT) return notEnough(category, 'too little happened in this session to rate it.', criteria);
  // Weights of criteria that couldn't be judged are spread over the rest.
  const scale = SCALE / judgedWeight;
  const score = Math.round(judged.reduce((n, c) => n + c.weight * c.value!, 0) * scale);
  const factors: Factor[] = judged
    .map((c) => ({ delta: -Math.round(c.weight * (1 - c.value!) * scale), text: c.detail, skill: c.value! < 1 ? c.skill : null, evidenceIds: c.evidenceIds }))
    .filter((x) => x.delta < 0);
  // Explanation: the criterion that cost the most, or the strongest one.
  const worst = [...factors].sort((a, b) => a.delta - b.delta)[0];
  const best = [...judged].sort((a, b) => b.weight * b.value! - a.weight * a.value!)[0];
  const explanation = worst && worst.delta <= -8 ? worst.text : best ? best.detail : 'Nothing stood out either way.';
  return { category, score, explanation, criteria, factors, evidenceIds: [...new Set(judged.flatMap((c) => c.evidenceIds))] };
}

export const scoreEngagement = (f: SessionFacts, ev: EvidenceItem[]) => scoreCategory('engagement', f, ev);
export const scoreCommunication = (f: SessionFacts, ev: EvidenceItem[]) => scoreCategory('communication', f, ev);
export const scoreTeaching = (f: SessionFacts, ev: EvidenceItem[]) => scoreCategory('teaching', f, ev);

export function overallScore(r: Record<Category, { score: number | null }>): number | null {
  const rated = CATEGORIES.filter((c) => r[c].score !== null);
  if (!rated.length) return null;
  const w = rated.reduce((n, c) => n + OVERALL_WEIGHTS[c], 0);
  return Math.round(rated.reduce((n, c) => n + OVERALL_WEIGHTS[c] * r[c].score!, 0) / w);
}

export function scoresFromFacts(f: SessionFacts, ev: EvidenceItem[]): Scores {
  const r = { engagement: scoreEngagement(f, ev), communication: scoreCommunication(f, ev), teaching: scoreTeaching(f, ev) };
  return { ...r, overall: overallScore(r), scale: 100 };
}

export function scoreSession(s: ScorableSession): Scores {
  return scoresFromFacts(factsFrom(s), s.evidence || []);
}

// Skills this session showed weakness in, most important first. Severity uses
// the criterion's own points lost (not the redistributed ones), weighted by how
// much its category counts toward the overall score; ~1 point per 10 overall points.
export function weaknesses(scores: Scores): { skill: Skill; severity: number; text: string }[] {
  const out = new Map<Skill, { skill: Skill; severity: number; text: string; top: number }>();
  for (const c of CATEGORIES) {
    if (scores[c].score === null) continue;
    for (const k of scores[c].criteria || []) {
      if (k.value === null || k.value >= 1) continue;
      const sev = (k.weight * (1 - k.value) * OVERALL_WEIGHTS[c]) / 10;
      const prev = out.get(k.skill);
      if (!prev) out.set(k.skill, { skill: k.skill, severity: sev, text: k.detail, top: sev });
      else {
        prev.severity += sev;
        if (sev > prev.top) Object.assign(prev, { text: k.detail, top: sev });
      }
    }
  }
  return [...out.values()]
    .filter((w) => w.severity >= 0.3) // ignore trivial deductions
    .sort((a, b) => b.severity - a.severity || SKILL_IDS.indexOf(a.skill) - SKILL_IDS.indexOf(b.skill))
    .map(({ skill, severity, text }) => ({ skill, severity: Math.round(severity * 100) / 100, text }));
}
