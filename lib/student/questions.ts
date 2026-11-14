// Adaptive question selection. Code picks WHAT to ask about (target concept or
// misconception) and WHICH kind of question; the LLM only phrases it.
//
// Each candidate gets a weighted score; the best one is asked if it clears a
// threshold. A small seeded random bonus keeps it from feeling robotic.

import type { ConceptState, QuestionPlan, QuestionType, StudentModel, StudentQuestion } from './types.ts';
import { getLevel, type Level } from '../levels.ts';

export const W = {
  lowMastery: 1.0,
  mentionedNotExplained: 1.1,
  weakExplanation: 0.6,
  prerequisiteGap: 1.4,
  misconceptionActive: 2.2, // not yet voiced and on-topic: the student objects first
  misconceptionVoiced: 1.3, // already voiced: lower, so it doesn't nag
  misconceptionPartial: 1.2,
  followUp: 1.7,
  challenge: 0.9,
  curiosity: 0.5,
  monologueBoost: 0.8,
  repeatPenalty: 0.9,
  randomness: 0.25,
  threshold: 0.85,
  monologueThreshold: 0.6,
};

export interface SelectContext {
  recentConceptIds: string[]; // concepts touched in the latest evaluated segments
  rng: () => number; // inject for deterministic tests
  monologue?: boolean; // teacher has talked a long time without a check-in
}

interface Candidate {
  type: QuestionType;
  conceptId: string | null;
  misconceptionId: string | null;
  followsQuestionId: string | null;
  reason: string;
  score: number;
}

const BEGINNER = new Set(['kindergarten', 'middle']);

function conceptQuestionType(reason: 'unexplained' | 'weak' | 'low', c: ConceptState, level: Level, model: StudentModel): QuestionType {
  const explainedPrereq = c.prerequisites.some((p) => model.concepts.find((x) => x.id === p)?.explained);
  if (reason === 'unexplained') {
    if (level.id === 'expert') return 'challenge';
    return level.id === 'college' ? 'clarify' : 'define_term';
  }
  if (reason === 'weak') {
    if (BEGINNER.has(level.id)) return 'example';
    if (level.id === 'expert') return 'challenge';
    return explainedPrereq ? 'relate' : 'clarify';
  }
  for (const t of level.params.preferredTypes) {
    if (t === 'relate' && !explainedPrereq) continue;
    if (t === 'challenge' && c.mastery < 55) continue;
    if (['define_term', 'example', 'clarify', 'relate', 'challenge'].includes(t)) return t;
  }
  return 'clarify';
}

// Was this exact thing already asked and answered well? Then don't ask again.
function alreadyAnswered(questions: StudentQuestion[], c: Candidate): boolean {
  return questions.some(
    (q) =>
      q.status === 'answered' &&
      q.type === c.type &&
      q.conceptId === c.conceptId &&
      q.misconceptionId === c.misconceptionId
  );
}

export function scoreCandidates(model: StudentModel, ctx: SelectContext): Candidate[] {
  const level = getLevel(model.levelId);
  const recent = new Set(ctx.recentConceptIds);
  const out: Candidate[] = [];
  const add = (c: Omit<Candidate, 'followsQuestionId'> & { followsQuestionId?: string | null }) =>
    out.push({ followsQuestionId: null, ...c });

  // Concepts: low mastery, mentioned-but-unexplained, weakly explained.
  for (const c of model.concepts) {
    const isRecent = recent.has(c.id);
    const relevance = isRecent ? 1 : c.mentioned ? 0.5 : 0.15;
    const low = ((100 - c.mastery) / 100) * W.lowMastery * relevance;
    if (c.mentioned && !c.explained) {
      add({ type: conceptQuestionType('unexplained', c, level, model), conceptId: c.id, misconceptionId: null, reason: 'mentioned but not explained', score: low + W.mentionedNotExplained * (isRecent ? 1 : 0.6) });
    } else if (c.explained && isRecent && c.mastery - c.initialMastery < 10) {
      add({ type: conceptQuestionType('weak', c, level, model), conceptId: c.id, misconceptionId: null, reason: 'explained but not landing', score: low + W.weakExplanation });
    } else if (c.mentioned) {
      add({ type: conceptQuestionType('low', c, level, model), conceptId: c.id, misconceptionId: null, reason: 'low mastery', score: low });
    }
    // Advanced students push on ideas they already follow.
    if ((level.id === 'college' || level.id === 'expert') && c.explained && isRecent && c.mastery >= 55) {
      add({ type: 'challenge', conceptId: c.id, misconceptionId: null, reason: 'probe an edge case', score: W.challenge });
    }
  }

  // Prerequisite gaps: the teacher is building on something the student lacks.
  for (const id of recent) {
    const c = model.concepts.find((x) => x.id === id);
    for (const pid of c?.prerequisites || []) {
      const p = model.concepts.find((x) => x.id === pid);
      if (p && p.mastery < 35 && !p.explained) {
        add({ type: 'prerequisite', conceptId: p.id, misconceptionId: null, reason: `needed for ${c!.name}`, score: W.prerequisiteGap + (35 - p.mastery) / 100 });
      }
    }
  }

  // Misconceptions colour the student's questions until they are resolved.
  for (const m of model.misconceptions) {
    if (m.status === 'resolved') continue;
    const c = model.concepts.find((x) => x.id === m.conceptId);
    const where = recent.has(m.conceptId) ? 1 : c?.mentioned ? 0.6 : 0.2;
    const base = m.status === 'partially_addressed' ? W.misconceptionPartial : m.expressed ? W.misconceptionVoiced : W.misconceptionActive;
    add({ type: 'misconception', conceptId: m.conceptId, misconceptionId: m.id, reason: m.status === 'active' ? 'holds a misconception' : 'still unsure after a partial correction', score: base * where });
  }

  // Follow up on the latest question if it wasn't fully answered.
  const last = model.questions[model.questions.length - 1];
  if (last && (last.status === 'partially_answered' || last.status === 'unanswered')) {
    const alreadyFollowed = model.questions.some((q) => q.type === 'follow_up' && q.text && q.at > last.at);
    if (!alreadyFollowed) {
      add({ type: 'follow_up', conceptId: last.conceptId, misconceptionId: last.misconceptionId, followsQuestionId: last.id, reason: `last question ${last.status.replace('_', ' ')}`, score: W.followUp });
    }
  }

  // Natural curiosity about what comes next in the material.
  const lastTaught = model.concepts.reduce((i, c, idx) => (c.mentioned ? idx : i), -1);
  const nextC = model.concepts[lastTaught + 1];
  if (nextC && !nextC.mentioned) {
    add({ type: 'curiosity', conceptId: nextC.id, misconceptionId: null, reason: 'curious about what comes next', score: W.curiosity });
  }

  // Penalties, repeats, monologue boost, and a little randomness.
  const lastTwo = model.questions.slice(-2);
  return out
    .filter((c) => !alreadyAnswered(model.questions, c))
    .map((c) => {
      let s = c.score;
      if (c.type !== 'follow_up' && c.conceptId && lastTwo.some((q) => q.conceptId === c.conceptId)) s -= W.repeatPenalty;
      if (ctx.monologue && c.conceptId && recent.has(c.conceptId)) s += W.monologueBoost;
      s += ctx.rng() * W.randomness;
      return { ...c, score: Math.round(s * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score);
}

export function selectQuestion(model: StudentModel, ctx: SelectContext): QuestionPlan | null {
  const ranked = scoreCandidates(model, ctx);
  const best = ranked[0];
  const threshold = ctx.monologue ? W.monologueThreshold : W.threshold;
  if (!best || best.score < threshold) return null;
  return { kind: 'question', ...best, type: ctx.monologue && best.type === 'curiosity' ? 'check_in' : best.type };
}

// Record a question the student actually asked.
export function recordQuestion(model: StudentModel, plan: QuestionPlan, text: string, at: number): StudentModel {
  const next = structuredClone(model);
  next.questions = [
    ...next.questions,
    {
      id: `q${next.questions.length + 1}`,
      at,
      conceptId: plan.conceptId,
      misconceptionId: plan.misconceptionId,
      type: plan.type,
      text,
      status: 'pending',
      segmentsSinceAsked: 0,
      answerQuote: '',
    },
  ];
  if (plan.misconceptionId) {
    const m = next.misconceptions.find((x) => x.id === plan.misconceptionId);
    if (m) m.expressed = true;
  }
  return next;
}

// Seeded PRNG (mulberry32) so a session's "random" curiosity is reproducible in tests.
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
