// Deterministic tracking of what the USER has shown they understand, per
// checklist concept. Fed by the same background evaluation the session already
// runs (one LLM proposal per stable segment, quotes verified against the
// segment), plus whiteboard snapshots, which are evaluated the same way.
//
// Rules:
// - Mentioning a concept makes it "Discussed", never "Demonstrated".
// - "Demonstrated" needs an accurate explanation AND a follow-up question on it
//   answered fully and correctly, with no error left uncorrected.
// - An error is cleared only by a later accurate explanation of that concept.

import type { EvaluationProposal, Extraction, QuestionPlan, Segment, StudentModel } from '../student/types.ts';
import { normalize, quoteAppearsIn } from '../verify.ts';
import type { BoardAnalysis, Coverage, Depth, LearnerConcept, LearnerState, Understanding } from './types.ts';

const MAX_OMISSIONS = 4;

export function initLearner(ext: Extraction, focusConceptIds: string[] = []): LearnerState {
  const ids = new Set(ext.concepts.map((c) => c.id));
  return {
    version: 1,
    concepts: ext.concepts.map((c) => ({
      id: c.id,
      name: c.name,
      coverage: 'not_covered',
      mentioned: false,
      depth: 0,
      explanations: [],
      probes: [],
      errors: [],
      omissions: [],
      whiteboard: [],
    })),
    focusConceptIds: focusConceptIds.filter((id) => ids.has(id)),
    board: { latest: null, pendingClarify: null, fresh: false, askedClarify: [] },
  };
}

const goodExplanation = (c: LearnerConcept) => c.explanations.some((e) => e.correctness === 'correct' && e.clarity !== 'unclear');
const openErrors = (c: LearnerConcept) => c.errors.filter((e) => !e.corrected);
const passedProbe = (c: LearnerConcept) => c.probes.some((p) => p.answer === 'full' && p.correct === true);

export function coverageOf(c: LearnerConcept): Coverage {
  if (goodExplanation(c) && passedProbe(c) && openErrors(c).length === 0) return 'demonstrated';
  if (c.explanations.length || c.errors.length || c.whiteboard.length || c.probes.some((p) => p.answer !== 'pending') || c.mentioned) return 'discussed';
  return 'not_covered';
}

export function understandingOf(c: LearnerConcept): Understanding {
  if (coverageOf(c) === 'demonstrated') return 'demonstrated';
  const someRight =
    c.explanations.some((e) => e.correctness === 'correct' || e.correctness === 'partially_correct') ||
    c.probes.some((p) => (p.answer === 'full' || p.answer === 'partial') && p.correct === true);
  return someRight ? 'partial' : 'not_verified';
}

// One short, deterministic reason per concept (no scores).
export function understandingNote(c: LearnerConcept): string {
  const u = understandingOf(c);
  const errs = openErrors(c);
  if (u === 'demonstrated') return 'Explained accurately and handled a follow-up question on it.';
  if (errs.length) return c.explanations.some((e) => e.correctness === 'correct') ? 'Partly right, but an error was left uncorrected.' : 'What was said about it was inaccurate.';
  if (u === 'partial') {
    if (!passedProbe(c)) return c.probes.some((p) => p.answer !== 'pending') ? "Explained, but a follow-up question wasn't fully answered." : 'Explained, but not yet tested with a follow-up question.';
    return 'Partly explained; part of it was vague or incomplete.';
  }
  if (c.explanations.length) return 'The explanation was too vague to count.';
  if (coverageOf(c) === 'discussed') return 'Mentioned, but not explained.';
  return 'Not covered.';
}

function refresh(l: LearnerState): LearnerState {
  for (const c of l.concepts) c.coverage = coverageOf(c);
  return l;
}

// The student asked a question; remember it so the answer can be judged.
export function recordProbe(l: LearnerState, plan: QuestionPlan, questionId: string, text: string, at: number): LearnerState {
  const next: LearnerState = structuredClone(l);
  const c = next.concepts.find((x) => x.id === plan.conceptId);
  if (c) {
    // Any earlier unanswered probe on this concept is superseded.
    for (const p of c.probes) if (p.answer === 'pending') p.answer = 'none';
    c.probes.push({ questionId, at, type: plan.type, depth: c.depth, text, answer: 'pending', correct: null, quote: '' });
  }
  if (plan.type === 'board_clarify' && next.board.pendingClarify) {
    next.board.askedClarify = [...next.board.askedClarify, next.board.pendingClarify.snapshotId];
    next.board.pendingClarify = null;
  }
  if (plan.type === 'board_question' || plan.type === 'board_clarify') next.board.fresh = false;
  return refresh(next);
}

const bump = (d: Depth, by: number): Depth => Math.max(0, Math.min(3, d + by)) as Depth;

export function applyLearnerEvaluation(
  l: LearnerState,
  seg: Segment,
  proposal: EvaluationProposal | null | undefined,
  after: StudentModel,
): LearnerState {
  if (!proposal || !seg || seg.speaker !== 'teacher') return l;
  const next: LearnerState = structuredClone(l);
  const source = seg.source === 'whiteboard' ? 'whiteboard' : 'speech';
  const real = (q: string | undefined) => !!q && quoteAppearsIn(q, seg.text);
  const byId = (id: string) => next.concepts.find((c) => c.id === String(id || '').toLowerCase());
  const incorrectIn = new Set<string>();

  for (const p of proposal.concepts || []) {
    const c = byId(p.concept_id);
    if (!c || !real(p.quote)) continue;
    c.mentioned = true;
    if (source === 'whiteboard') c.whiteboard.push({ at: seg.start, snapshotId: seg.id, quote: p.quote });
    if (p.explained) {
      c.explanations.push({ segmentId: seg.id, at: seg.start, quote: p.quote, correctness: p.correctness, clarity: p.clarity, source });
      if (p.correctness === 'incorrect') {
        incorrectIn.add(c.id);
        c.errors.push({ segmentId: seg.id, at: seg.start, quote: p.quote, source, kind: 'incorrect', corrected: false, correctedQuote: '' });
      } else if (p.correctness === 'correct') {
        for (const e of c.errors) if (!e.corrected) Object.assign(e, { corrected: true, correctedQuote: p.quote });
        // A clear, accurate explanation (with an example) means basics are covered.
        if (p.clarity === 'clear' && c.depth === 0) c.depth = 1;
      }
    }
    const gap = String(p.gap || '').trim();
    if (gap && !(p.explained && p.correctness === 'correct' && p.clarity === 'clear')) {
      const om = c.omissions.filter((o) => normalize(o.question) !== normalize(gap));
      c.omissions = [...om, { at: seg.start, question: gap.slice(0, 160), quote: p.quote }].slice(-MAX_OMISSIONS);
    }
  }

  // The AI student's own misconceptions double as tests: agreeing with one is
  // an error; correcting it counts like answering a probe well.
  for (const p of proposal.misconceptions || []) {
    const m = after.misconceptions.find((x) => x.id === String(p.misconception_id || '').toLowerCase());
    const c = m && byId(m.conceptId);
    if (!m || !c || !real(p.quote)) continue;
    c.mentioned = true;
    if (p.effect === 'reinforced') {
      incorrectIn.add(c.id);
      c.errors.push({ segmentId: seg.id, at: seg.start, quote: p.quote, source, kind: 'endorsed_misconception', corrected: false, correctedQuote: '' });
    } else if (p.effect === 'corrected' && m.expressed) {
      const probe = [...c.probes].reverse().find((x) => x.type === 'misconception' && x.answer === 'pending');
      if (probe) Object.assign(probe, { answer: 'full', correct: true, quote: p.quote });
      else c.probes.push({ questionId: `m:${m.id}`, at: seg.start, type: 'misconception', depth: c.depth, text: m.belief, answer: 'full', correct: true, quote: p.quote });
      for (const e of c.errors) if (!e.corrected) Object.assign(e, { corrected: true, correctedQuote: p.quote });
    }
  }

  // Did this segment answer the student's latest question? The deterministic
  // student engine already judged that (quote-checked) on `after.questions`.
  for (const c of next.concepts) {
    for (const probe of c.probes) {
      if (probe.answer !== 'pending') continue;
      const q = after.questions.find((x) => x.id === probe.questionId);
      if (!q || q.status === 'pending') continue;
      const answer = q.status === 'answered' ? 'full' : q.status === 'partially_answered' ? 'partial' : 'none';
      probe.answer = answer;
      probe.quote = q.answerQuote || '';
      if (answer === 'none') continue;
      probe.correct = !incorrectIn.has(c.id);
      if (answer === 'full' && probe.correct) c.depth = bump(c.depth, 1);
      if (probe.correct === false) c.depth = bump(c.depth, -1);
    }
  }
  return refresh(next);
}

export function applyBoard(l: LearnerState, a: BoardAnalysis): LearnerState {
  const next: LearnerState = structuredClone(l);
  if (a.blank) return next;
  next.board.latest = { ...a, thumb: undefined };
  next.board.fresh = true;
  const unclear = a.unclear[0];
  if (unclear && !next.board.askedClarify.includes(a.id)) next.board.pendingClarify = { snapshotId: a.id, part: unclear.part, question: unclear.question };
  return next;
}

export function learnerSummary(l: LearnerState) {
  return l.concepts.map((c) => ({ id: c.id, name: c.name, coverage: c.coverage, understanding: understandingOf(c), note: understandingNote(c) }));
}
