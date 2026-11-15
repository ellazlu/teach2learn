// Practice challenges: a realistic student scenario plus measurable success
// criteria, checked by the same deterministic facts the rubric uses so that
// attempts are always compared on identical terms.

import type { LevelId } from '../student/types.ts';
import { CATEGORIES, SKILLS, SKILL_IDS, type Category, type Scores, type SessionFacts, type Skill } from './rubric.ts';

export type Metric =
  | 'check_ins'
  | 'questions_answered_ratio'
  | 'max_run_seconds'
  | 'undefined_terms'
  | 'unclear_explanations'
  | 'incorrect_explanations'
  | 'misconceptions_resolved'
  | 'concepts_demonstrated'
  | 'shallow_explanations'
  | 'concepts_explained'
  | 'rating_overall'
  | 'rating_engagement'
  | 'rating_communication'
  | 'rating_teaching';

export const METRICS: Record<Metric, { label: string; unit: string }> = {
  check_ins: { label: 'Times you checked understanding or asked the student to think', unit: '' },
  questions_answered_ratio: { label: "Share of the student's questions you answered", unit: '%' },
  max_run_seconds: { label: 'Longest stretch talking without a check-in', unit: 's' },
  undefined_terms: { label: 'Terms used without explaining them', unit: '' },
  unclear_explanations: { label: 'Explanations the student could not follow', unit: '' },
  incorrect_explanations: { label: "Explanations that didn't match the material", unit: '' },
  misconceptions_resolved: { label: 'Misconceptions resolved', unit: '' },
  concepts_demonstrated: { label: 'Concepts the student showed it understood', unit: '' },
  shallow_explanations: { label: 'Explanations missing the why or an essential part', unit: '' },
  concepts_explained: { label: 'Key concepts explained', unit: '' },
  rating_overall: { label: 'Overall score', unit: '/100' },
  rating_engagement: { label: 'Engagement score', unit: '/100' },
  rating_communication: { label: 'Communication score', unit: '/100' },
  rating_teaching: { label: 'Teaching effectiveness score', unit: '/100' },
};
export const METRIC_IDS = Object.keys(METRICS) as Metric[];

export interface Criterion {
  metric: Metric;
  op: '>=' | '<=';
  target: number;
}

export interface CriterionResult extends Criterion {
  actual: number | null;
  met: boolean | null; // null = not enough evidence to judge
}

export interface Scenario {
  topic: string;
  levelId: LevelId;
  timeLimitSec: number;
  studentProfile: string; // how the simulated student behaves, fed to the student's prompt
  misconception: string; // a belief the student starts with, or ''
}

export interface Attempt {
  sessionId: string;
  at: string;
  met: number;
  judged: number;
  total: number;
  results: CriterionResult[];
}

export type ChallengeStatus = 'active' | 'completed' | 'replaced';

export interface Challenge {
  id: string;
  createdAt: string;
  fromSessionId: string;
  skill: Skill;
  title: string;
  goal: string; // one sentence the tutor sees during the session
  scenario: Scenario;
  criteria: Criterion[];
  rationale: string; // why this skill, with reference to evidence
  difficulty: 1 | 2 | 3;
  status: ChallengeStatus;
  attempts: Attempt[];
  source: 'agent' | 'template';
}

// ---- Measuring -------------------------------------------------------------------

export function measure(metric: Metric, f: SessionFacts, scores: Scores): number | null {
  if (f.teacherWords < 40) return null;
  switch (metric) {
    case 'check_ins': return f.invitations;
    case 'questions_answered_ratio':
      return f.studentQuestions ? Math.round(((f.answered + 0.5 * f.partlyAnswered) / f.studentQuestions) * 100) : null;
    case 'max_run_seconds': return f.maxRunSec;
    case 'undefined_terms': return f.undefinedTerms;
    case 'unclear_explanations': return f.unclear;
    case 'incorrect_explanations': return f.incorrect;
    case 'misconceptions_resolved':
      // Only judgeable if a misconception was actually in play.
      return f.misconceptionsResolved + f.misconceptionsLeftStanding > 0 ? f.misconceptionsResolved : null;
    case 'concepts_demonstrated': return f.conceptsExplained > 0 || f.demoAttempts > 0 ? f.demonstrated : null;
    case 'shallow_explanations': return f.accurate + f.shallow > 0 ? f.shallow : null;
    case 'concepts_explained': return f.conceptsExplained;
    case 'rating_overall': return scores.overall ?? null;
    default: {
      const cat = metric.replace('rating_', '') as Category;
      return scores[cat]?.score ?? null;
    }
  }
}

export function evaluateCriteria(criteria: Criterion[], f: SessionFacts, scores: Scores): CriterionResult[] {
  return criteria.map((c) => {
    const actual = measure(c.metric, f, scores);
    const met = actual === null ? null : c.op === '>=' ? actual >= c.target : actual <= c.target;
    return { ...c, actual, met };
  });
}

export function makeAttempt(sessionId: string, at: string, results: CriterionResult[]): Attempt {
  return {
    sessionId,
    at,
    met: results.filter((r) => r.met === true).length,
    judged: results.filter((r) => r.met !== null).length,
    total: results.length,
    results,
  };
}

export function describeCriterion(c: Criterion): string {
  const m = METRICS[c.metric];
  const target = c.metric === 'questions_answered_ratio' ? `${c.target}%` : `${c.target}${m.unit}`;
  if (c.metric === 'max_run_seconds') return `Never talk more than ${target} without checking in`;
  if (c.op === '<=' && c.target === 0) return `${m.label}: none`;
  return `${m.label}: ${c.op === '>=' ? 'at least' : 'at most'} ${target}`;
}

// ---- Validation (agent output is checked before it's saved) ----------------------

const LEVELS: LevelId[] = ['kindergarten', 'middle', 'high', 'college', 'expert'];
const RANGE: Record<Metric, [number, number]> = {
  check_ins: [1, 10],
  questions_answered_ratio: [50, 100],
  max_run_seconds: [20, 120],
  undefined_terms: [0, 3],
  unclear_explanations: [0, 3],
  incorrect_explanations: [0, 2],
  misconceptions_resolved: [1, 3],
  concepts_demonstrated: [1, 3],
  shallow_explanations: [0, 2],
  concepts_explained: [1, 5],
  rating_overall: [40, 100],
  rating_engagement: [40, 100],
  rating_communication: [40, 100],
  rating_teaching: [40, 100],
};
// The direction that means "better" for each metric.
const BETTER: Record<Metric, '>=' | '<='> = {
  check_ins: '>=', questions_answered_ratio: '>=', max_run_seconds: '<=', undefined_terms: '<=', unclear_explanations: '<=',
  incorrect_explanations: '<=', misconceptions_resolved: '>=', concepts_demonstrated: '>=',
  shallow_explanations: '<=', concepts_explained: '>=',
  rating_overall: '>=', rating_engagement: '>=', rating_communication: '>=', rating_teaching: '>=',
};

export interface ChallengeDraft {
  skill: string;
  title: string;
  goal: string;
  student_profile: string;
  misconception?: string;
  topic: string;
  level_id: string;
  time_limit_sec: number;
  criteria: { metric: string; op?: string; target: number }[];
  rationale: string;
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function validateChallenge(d: ChallengeDraft, ctx: { sessionId: string; now: string; id: string; difficulty?: 1 | 2 | 3; source: Challenge['source'] }): { ok: true; challenge: Challenge } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!SKILL_IDS.includes(d?.skill as Skill)) errors.push(`skill must be one of: ${SKILL_IDS.join(', ')}`);
  if (!LEVELS.includes(d?.level_id as LevelId)) errors.push(`level_id must be one of: ${LEVELS.join(', ')}`);
  const t = Number(d?.time_limit_sec);
  if (!Number.isFinite(t) || t < 60 || t > 300) errors.push('time_limit_sec must be between 60 and 300');
  for (const [k, max] of [['title', 80], ['goal', 200], ['student_profile', 400], ['topic', 120], ['rationale', 400]] as const) {
    if (!clean((d as any)?.[k], max)) errors.push(`${k} is required`);
  }
  const criteria: Criterion[] = [];
  const list = Array.isArray(d?.criteria) ? d.criteria : [];
  if (list.length < 1 || list.length > 3) errors.push('give 1 to 3 criteria');
  for (const c of list) {
    if (!METRIC_IDS.includes(c?.metric as Metric)) { errors.push(`unknown metric "${c?.metric}"; use one of: ${METRIC_IDS.join(', ')}`); continue; }
    const m = c.metric as Metric;
    const [lo, hi] = RANGE[m];
    const target = Number(c.target);
    if (!Number.isFinite(target) || target < lo || target > hi) { errors.push(`${m} target must be between ${lo} and ${hi}`); continue; }
    if (criteria.some((x) => x.metric === m)) { errors.push(`duplicate metric ${m}`); continue; }
    criteria.push({ metric: m, op: BETTER[m], target });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    challenge: {
      id: ctx.id,
      createdAt: ctx.now,
      fromSessionId: ctx.sessionId,
      skill: d.skill as Skill,
      title: clean(d.title, 80),
      goal: clean(d.goal, 200),
      scenario: {
        topic: clean(d.topic, 120),
        levelId: d.level_id as LevelId,
        timeLimitSec: Math.round(t / 30) * 30,
        studentProfile: clean(d.student_profile, 400),
        misconception: clean(d.misconception, 200),
      },
      criteria,
      rationale: clean(d.rationale, 400),
      difficulty: ctx.difficulty || 2,
      status: 'active',
      attempts: [],
      source: ctx.source,
    },
  };
}

// ---- Deterministic templates (used when the agent is unavailable) ------------------

interface Template {
  title: string;
  goal: string;
  profile: string;
  criteria: (d: 1 | 2 | 3) => { metric: Metric; target: number }[];
}

export const TEMPLATES: Record<Skill, Template> = {
  checking_understanding: {
    title: 'The quiet student',
    goal: 'Check what the student understands before moving on.',
    profile: 'This student rarely says when it is lost. It nods along and only reveals confusion when the tutor asks it to explain or apply something.',
    criteria: (d) => [{ metric: 'check_ins', target: d + 1 }, { metric: 'max_run_seconds', target: [90, 75, 60][d - 1] }],
  },
  responding_to_questions: {
    title: 'The curious student',
    goal: "Answer each of the student's questions directly before continuing.",
    profile: 'This student asks frequent, specific questions and gets lost if a question is skipped or only half answered.',
    criteria: (d) => [{ metric: 'questions_answered_ratio', target: [67, 75, 90][d - 1] }],
  },
  student_participation: {
    title: 'Let them talk',
    goal: 'Get the student to do some of the thinking out loud.',
    profile: 'This student is passive and will listen indefinitely unless the tutor gives it something to do, like predicting, explaining back or trying an example.',
    criteria: (d) => [{ metric: 'check_ins', target: d + 1 }, { metric: 'max_run_seconds', target: [90, 75, 60][d - 1] }],
  },
  clear_language: {
    title: 'No jargon',
    goal: 'Explain every technical word the first time you use it.',
    profile: 'This student is new to the subject and does not know its vocabulary. It asks what words mean when they are not explained.',
    criteria: (d) => [{ metric: 'undefined_terms', target: d >= 2 ? 0 : 1 }, { metric: 'rating_communication', target: [65, 75, 85][d - 1] }],
  },
  clarity_and_pacing: {
    title: 'One step at a time',
    goal: 'Explain one idea at a time, in short, concrete steps.',
    profile: 'This student gets overwhelmed when several ideas come at once. It follows well when ideas come one by one with an example.',
    criteria: (d) => [{ metric: 'unclear_explanations', target: d >= 2 ? 0 : 1 }, { metric: 'rating_communication', target: [65, 75, 85][d - 1] }],
  },
  accuracy: {
    title: 'Get it exactly right',
    goal: 'Keep every explanation accurate to the material.',
    profile: 'This student is sharp and repeats back exactly what it is told, so any inaccuracy becomes its belief.',
    criteria: (d) => [{ metric: 'incorrect_explanations', target: 0 }, { metric: 'rating_teaching', target: [55, 65, 75][d - 1] }],
  },
  explaining_reasoning: {
    title: 'But why?',
    goal: 'For each idea, say why it works that way, not just what happens.',
    profile: 'This student always wants the reason. It is not satisfied by "that\'s just how it is" and asks "but why?" until it hears the mechanism.',
    criteria: (d) => [{ metric: 'shallow_explanations', target: d >= 2 ? 0 : 1 }, ...(d >= 2 ? [{ metric: 'rating_teaching' as Metric, target: [55, 65, 75][d - 1] }] : [])],
  },
  covering_key_ideas: {
    title: 'Hit the essentials',
    goal: 'Explain each key idea briefly before going deep on any one of them.',
    profile: 'This student is preparing for a test tomorrow and needs the big picture: it gets anxious if one detail takes the whole session.',
    criteria: (d) => [{ metric: 'concepts_explained', target: Math.min(3, d + 1) }],
  },
  addressing_misconceptions: {
    title: 'The confident misconception',
    goal: "Find the student's wrong idea and correct it so it sticks.",
    profile: 'This student holds a common misconception confidently and will bring it up. It only lets go of it if the tutor explains why it is wrong, not just what is right.',
    criteria: (d) => [{ metric: 'misconceptions_resolved', target: 1 }, ...(d >= 2 ? [{ metric: 'rating_teaching' as Metric, target: [55, 65, 75][d - 1] }] : [])],
  },
  building_understanding: {
    title: 'Prove they got it',
    goal: 'Get the student to explain or apply one concept correctly on its own.',
    profile: 'This student thinks it understands after hearing an explanation, but often cannot explain it back without practice.',
    criteria: (d) => [{ metric: 'concepts_demonstrated', target: d >= 3 ? 2 : 1 }, ...(d >= 2 ? [{ metric: 'check_ins' as Metric, target: 2 }] : [])],
  },
};

// Difficulty moves with results: up after meeting every criterion, down after
// meeting none, otherwise unchanged.
export function nextDifficulty(prev: Challenge | null, skill: Skill): 1 | 2 | 3 {
  if (!prev || prev.skill !== skill || !prev.attempts.length) return prev?.skill === skill ? prev.difficulty : 1;
  const last = prev.attempts[prev.attempts.length - 1];
  if (last.judged && last.met === last.total) return Math.min(3, prev.difficulty + 1) as 1 | 2 | 3;
  if (last.judged && last.met === 0) return Math.max(1, prev.difficulty - 1) as 1 | 2 | 3;
  return prev.difficulty;
}

export function templateDraft(skill: Skill, ctx: { topic: string; levelId: LevelId; difficulty: 1 | 2 | 3; reason: string; misconception?: string }): ChallengeDraft {
  const t = TEMPLATES[skill];
  return {
    skill,
    title: t.title,
    goal: t.goal,
    student_profile: t.profile,
    misconception: skill === 'addressing_misconceptions' ? ctx.misconception || '' : '',
    topic: ctx.topic,
    level_id: ctx.levelId,
    time_limit_sec: 120,
    criteria: t.criteria(ctx.difficulty).map((c) => ({ ...c })),
    rationale: ctx.reason || `Focus: ${SKILLS[skill].label.toLowerCase()}.`,
  };
}

// Evidence ids (E3) are for the coach and the logs, not for the tutor to read.
export function plainReason(t: string): string {
  return String(t || '')
    .replace(/\s*\((?:\s*E\d+\s*(?:,|and)?\s*)+\)/gi, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

export const ratingMetric = (c: Category): Metric => `rating_${c}` as Metric;
export { CATEGORIES };
