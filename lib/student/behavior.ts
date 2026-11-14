// Student behavior state machine + interjection policy.
//
// behaviorFromEvents(): what the latest evaluation makes the student feel.
// transition(): applies it with explicit rules (no contradictory jumps, no
//   changes while the student is speaking).
// decideAction(): when to ask a question, request clarification, or show
//   understanding — with cooldowns so it never interrupts constantly.

import type { BehaviorState, KnowledgeEvent, StudentAction, StudentModel } from './types.ts';
import { getLevel } from '../levels.ts';
import { selectQuestion } from './questions.ts';

export const MIN_DWELL_SEC = 3; // an emotional state lasts at least this long
export const WAIT_FOR_ANSWER_SEGMENTS = 2; // don't pile questions on an unanswered one
export const MONOLOGUE_SEC = 75; // this long without a break counts as a monologue

export function behaviorFromEvents(model: StudentModel, events: KnowledgeEvent[]): BehaviorState {
  const level = getLevel(model.levelId);
  const advanced = level.id === 'college' || level.id === 'expert';
  const has = (t: KnowledgeEvent['type']) => events.some((e) => e.type === t);

  const reinforced = events.some((e) => e.type === 'misconception_change' && e.to === 'active');
  const jargonConfuses = level.params.confusedBy !== 'vagueness';
  if (has('incorrect_explanation') || reinforced) return advanced ? 'challenging' : 'confused';
  if (has('unclear_explanation')) return advanced ? 'challenging' : 'confused';
  if (jargonConfuses && has('undefined_term')) return 'confused';

  const bigGain = events.some((e) => e.type === 'mastery_change' && e.to - e.from >= 6);
  const resolved = events.some((e) => e.type === 'misconception_change' && e.to === 'resolved');
  if (bigGain || resolved) return 'understanding';

  if (has('mentioned_only')) return 'curious';
  return 'listening';
}

// The only legal ways to change state. 'responding' is entered and left only
// through speaking=true/false, so evaluations can't override a student mid-sentence.
export function transition(
  current: BehaviorState,
  proposed: BehaviorState,
  opts: { speaking: boolean; now: number; since: number }
): BehaviorState {
  if (opts.speaking) return 'responding';
  if (current === 'responding') return 'listening';
  if (proposed === current) return current;
  // Strong signals (confusion/challenge) may interrupt a fresh state; mild ones wait.
  const strong = proposed === 'confused' || proposed === 'challenging';
  if (!strong && opts.now - opts.since < MIN_DWELL_SEC) return current;
  return proposed;
}

export interface PolicyContext {
  model: StudentModel;
  events: KnowledgeEvent[]; // from the latest evaluation
  now: number; // teaching seconds
  lastInterjectionAt: number; // -Infinity if never
  speaking: boolean;
  finishing: boolean;
  teacherRunSec: number; // current uninterrupted teacher speech
  recentConceptIds: string[];
  latestConceptIds?: string[];
  understandingShown: string[]; // concepts the student already paraphrased
  rng: () => number;
}

export function decideAction(ctx: PolicyContext): StudentAction {
  const { model } = ctx;
  if (ctx.finishing) return { kind: 'none', reason: 'session ending' };
  if (ctx.speaking) return { kind: 'none', reason: 'student is already speaking' };

  const open = [...model.questions].reverse().find((q) => q.status === 'pending');
  if (open && open.segmentsSinceAsked < WAIT_FOR_ANSWER_SEGMENTS) return { kind: 'none', reason: 'waiting for an answer' };

  const level = getLevel(model.levelId);
  const confused = model.behavior === 'confused' || model.behavior === 'challenging';
  const minGap = confused ? level.params.minGapSec * 0.6 : level.params.minGapSec;
  if (ctx.now - ctx.lastInterjectionAt < minGap) return { kind: 'none', reason: 'cooldown' };

  const monologue = ctx.teacherRunSec >= MONOLOGUE_SEC;
  const plan = selectQuestion(model, { recentConceptIds: ctx.recentConceptIds, latestConceptIds: ctx.latestConceptIds, rng: ctx.rng, monologue });

  // Show understanding after a clear explanation, unless something more pressing is waiting.
  if (model.behavior === 'understanding' && (!plan || plan.score < 1.3)) {
    const gain = ctx.events
      .filter((e): e is Extract<KnowledgeEvent, { type: 'mastery_change' }> => e.type === 'mastery_change')
      .filter((e) => e.to - e.from >= 8 && !ctx.understandingShown.includes(e.conceptId))
      .sort((a, b) => b.to - b.from - (a.to - a.from))[0];
    if (gain) return { kind: 'show_understanding', conceptId: gain.conceptId, reason: `understood ${gain.conceptId} (+${gain.to - gain.from})` };
  }

  if (plan) return plan;
  return { kind: 'none', reason: 'nothing worth interrupting for' };
}
