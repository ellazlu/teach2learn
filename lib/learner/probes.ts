// Teach to Learn: what the AI student asks next. Code picks the target and the
// kind of question; the reply model only phrases it in character.
//
// Priorities: clear up an unreadable drawing > question an error the user
// made (without correcting them) > follow up on a half-answered question >
// the student's own misconception > the drawing they just shared > probe the
// concept they're explaining, one level deeper than last time > a prerequisite
// they skipped > curiosity about the next checklist item.

import type { QuestionPlan, QuestionType, StudentModel, TurnAction } from '../student/types.ts';
import { getLevel } from '../levels.ts';
import { detectTeacherQuestion, matchConcepts, MIN_TURN_WORDS, ACK_MIN_WORDS, ACK_PROBABILITY } from '../student/turns.ts';
import { wordCount } from '../student/segments.ts';
import type { Depth, LearnerConcept, LearnerState } from './types.ts';

export const P = {
  boardClarify: 3.0,
  errorCheck: 2.6,
  followUp: 2.0,
  misconception: 1.6,
  boardQuestion: 1.5,
  probe: 1.3,
  latest: 0.4,
  focus: 0.3,
  omission: 0.3,
  prerequisite: 1.2,
  mentionedOnly: 1.1,
  stretch: 0.7,
  curiosity: 0.75,
  moveOn: 0.4,
  repeat: 0.8,
  randomness: 0.2,
  threshold: 0.9,
};

const BOARD_TYPES: QuestionType[] = ['board_clarify', 'board_question'];

export function typeForDepth(c: LearnerConcept, model: StudentModel | null): QuestionType {
  const d: Depth = c.depth;
  if (d === 0) return 'clarify';
  if (d === 1) return 'reasoning';
  if (d === 2) {
    const mc = model?.concepts.find((x) => x.id === c.id);
    const related = mc?.prerequisites.some((p) => model?.concepts.find((x) => x.id === p)?.mentioned);
    return related ? 'relate' : 'assumption';
  }
  return c.probes.some((p) => p.type === 'apply_new') ? 'challenge' : 'apply_new';
}

export interface ProbeContext {
  recentConceptIds: string[];
  latestConceptIds: string[];
  rng: () => number;
  minScore?: number;
}

type Cand = Omit<QuestionPlan, 'kind'>;

export function scoreProbes(l: LearnerState, model: StudentModel | null, ctx: ProbeContext): Cand[] {
  const out: Cand[] = [];
  const recent = new Set(ctx.recentConceptIds);
  const latest = new Set(ctx.latestConceptIds);
  const focus = new Set(l.focusConceptIds);
  const add = (c: Partial<Cand> & Pick<Cand, 'type' | 'reason' | 'score'>) =>
    out.push({ conceptId: null, misconceptionId: null, followsQuestionId: null, focus: null, ...c });
  const allProbes = l.concepts.flatMap((c) => c.probes.map((p) => ({ ...p, conceptId: c.id }))).sort((a, b) => a.at - b.at);
  const lastProbe = allProbes[allProbes.length - 1];

  // 1) Something on the board couldn't be read: ask, don't guess.
  if (l.board.pendingClarify) {
    add({ type: 'board_clarify', conceptId: l.board.latest?.conceptIds[0] || null, focus: { question: l.board.pendingClarify.question, quote: l.board.pendingClarify.part }, reason: 'part of the drawing is unclear', score: P.boardClarify });
  }

  for (const c of l.concepts) {
    const isRecent = recent.has(c.id) || latest.has(c.id);
    const bonus = (latest.has(c.id) ? P.latest : 0) + (focus.has(c.id) ? P.focus : 0);
    // 2) An error the user hasn't corrected: ask a question that exposes it.
    const err = [...c.errors].reverse().find((e) => !e.corrected);
    const probedSince = err && c.probes.some((p) => p.type === 'error_check' && p.at >= err.at);
    if (err && !probedSince) {
      add({ type: 'error_check', conceptId: c.id, focus: { question: '', quote: err.quote }, reason: 'the explanation had an error', score: P.errorCheck + bonus });
    }
    if (!isRecent && !focus.has(c.id)) continue;
    // 6) Probe what they're explaining, one level deeper each time it's answered well.
    if (c.coverage !== 'demonstrated' && c.explanations.length) {
      const om = c.omissions[c.omissions.length - 1];
      const useOmission = om && c.depth <= 1;
      add({
        type: useOmission ? 'clarify' : typeForDepth(c, model),
        conceptId: c.id,
        focus: useOmission ? { question: om.question, quote: om.quote } : null,
        reason: useOmission ? `missing detail: "${om.question}"` : `depth ${c.depth} probe`,
        score: P.probe + bonus + (useOmission ? P.omission : 0),
      });
    } else if (c.coverage === 'demonstrated' && c.depth < 3) {
      add({ type: typeForDepth(c, model), conceptId: c.id, reason: 'they handle this well: stretch further', score: P.stretch + bonus });
    } else if (c.mentioned && !c.explanations.length) {
      add({ type: 'clarify', conceptId: c.id, reason: 'mentioned but not explained', score: P.mentionedOnly + bonus });
    }
    // 8) They're building on something they never explained.
    const mc = model?.concepts.find((x) => x.id === c.id);
    for (const pid of mc?.prerequisites || []) {
      const pre = l.concepts.find((x) => x.id === pid);
      if (pre && pre.coverage === 'not_covered') add({ type: 'prerequisite', conceptId: pre.id, reason: `needed for ${c.name}`, score: P.prerequisite });
    }
  }

  // 3) Follow up on a half-answered question.
  if (lastProbe && (lastProbe.answer === 'partial' || lastProbe.answer === 'none') && !BOARD_TYPES.includes(lastProbe.type)) {
    add({ type: 'follow_up', conceptId: lastProbe.conceptId, followsQuestionId: lastProbe.questionId, reason: `last question ${lastProbe.answer === 'none' ? 'not answered' : 'partly answered'}`, score: P.followUp });
  }

  // 4) The student's own misconception, raised once the topic comes up.
  for (const m of model?.misconceptions || []) {
    if (m.status !== 'active' || m.expressed) continue;
    if (!recent.has(m.conceptId)) continue;
    add({ type: 'misconception', conceptId: m.conceptId, misconceptionId: m.id, reason: 'tests whether they can correct a common wrong idea', score: P.misconception });
  }

  // 5) Ask about the drawing they just made.
  if (l.board.fresh && l.board.latest && !l.board.pendingClarify) {
    const b = l.board.latest;
    add({ type: 'board_question', conceptId: b.conceptIds[0] || null, focus: { question: '', quote: (b.transcription || b.description).slice(0, 160) }, reason: 'responding to the drawing', score: P.boardQuestion });
  }

  // 9) Curiosity about the next checklist item they haven't reached.
  const lastCovered = l.concepts.reduce((i, c, idx) => (c.coverage !== 'not_covered' ? idx : i), -1);
  const nextC = l.concepts.slice(lastCovered + 1).find((c) => c.coverage === 'not_covered');
  // Stronger once what they're on now is demonstrated: time to move on.
  const settled = [...latest].length > 0 && [...latest].every((id) => l.concepts.find((c) => c.id === id)?.coverage === 'demonstrated');
  if (nextC && lastCovered >= 0) {
    add({ type: 'curiosity', conceptId: nextC.id, reason: 'leads toward the next idea', score: P.curiosity + (settled ? P.moveOn : 0) + (focus.has(nextC.id) ? P.focus : 0) });
  }

  const lastTwo = allProbes.slice(-2).map((p) => p.conceptId);
  const passed = (c: Cand) => l.concepts.find((x) => x.id === c.conceptId)?.probes.some((p) => p.type === c.type && p.answer === 'full' && p.correct);
  return out
    .filter((c) => !(c.type !== 'follow_up' && c.type !== 'error_check' && passed(c)))
    .map((c) => {
      let s = c.score;
      if (!['follow_up', 'error_check', 'board_clarify', 'board_question'].includes(c.type) && c.conceptId && lastTwo.includes(c.conceptId)) s -= P.repeat;
      s += ctx.rng() * P.randomness;
      return { ...c, score: Math.round(s * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score);
}

export function selectProbe(l: LearnerState, model: StudentModel | null, ctx: ProbeContext): QuestionPlan | null {
  const best = scoreProbes(l, model, ctx)[0];
  if (!best || best.score < (ctx.minScore ?? P.threshold)) return null;
  return { kind: 'question', ...best };
}

export interface LearnerTurnContext {
  learner: LearnerState;
  model: StudentModel;
  turnText: string;
  now: number;
  lastStudentAt: number;
  lastStudentWasQuestion: boolean;
  recentConceptIds: string[];
  rng: () => number;
}

export function decideLearnerTurn(ctx: LearnerTurnContext): TurnAction {
  const level = getLevel(ctx.model.levelId);
  const words = wordCount(ctx.turnText);
  const matched = matchConcepts(ctx.turnText, ctx.model);
  const asked = detectTeacherQuestion(ctx.turnText);
  const pctx = { recentConceptIds: [...new Set([...matched, ...ctx.recentConceptIds])], latestConceptIds: matched, rng: ctx.rng };

  if (asked === 'check') {
    // "Does that make sense?" A curious student answers with what's still unclear.
    const plan = selectProbe(ctx.learner, ctx.model, { ...pctx, minScore: 0 });
    if (plan) return { kind: 'ask', plan, reason: `they checked in: ${plan.type} (${plan.reason})` };
    return { kind: 'answer', questionKind: 'check', conceptIds: matched, reason: 'they checked in' };
  }
  if (asked === 'content') return { kind: 'answer', questionKind: 'content', conceptIds: matched, reason: 'they asked the student something' };
  if (words < MIN_TURN_WORDS) return { kind: 'none', reason: 'still getting going' };
  if (ctx.lastStudentWasQuestion) return { kind: 'acknowledge', conceptId: matched[0] ?? null, reason: 'reacting to their answer' };
  if (ctx.now - ctx.lastStudentAt < level.params.minGapSec) return { kind: 'none', reason: 'letting them continue' };
  const plan = selectProbe(ctx.learner, ctx.model, pctx);
  if (plan) return { kind: 'ask', plan, reason: `${plan.type}: ${plan.reason}` };
  if (words >= ACK_MIN_WORDS && matched.length && ctx.rng() < ACK_PROBABILITY) return { kind: 'acknowledge', conceptId: matched[0], reason: 'following along' };
  return { kind: 'none', reason: 'following along quietly' };
}
