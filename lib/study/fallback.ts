// Deterministic study planner: the same investigate -> evaluate -> compare ->
// prioritize -> act steps with the same tools and fixed rules. Used when Deep
// Agents is unavailable, and to finish anything the agent left undone.

import { understandingOf } from '../learner/tracker.ts';
import { buildPlan, createPlannerTools, plog, rankGaps, type PlannerState } from './tools.ts';
import type { Practice, StudyPlan } from './types.ts';

async function call(tools: ReturnType<typeof createPlannerTools>, name: string, args: object = {}) {
  const t = tools.find((x) => x.name === name);
  return t ? JSON.parse(await t.run(args)) : null;
}

export const tooShort = (s: PlannerState) =>
  s.input.session.utterances.filter((u) => u.speaker === 'teacher').reduce((n, u) => n + u.text.split(/\s+/).length, 0) < 25 && !s.input.session.boards.some((b) => !b.blank);

// Fill in whatever the run left undone (everything, for a fresh state).
export async function completePlan(s: PlannerState, clock: () => number = Date.now): Promise<void> {
  const tools = createPlannerTools(s, clock);
  const done = (n: string) => s.log.some((e) => e.name === n && e.type === 'tool');
  const r = s.input.session;
  if (!done('get_session_overview')) {
    plog(s, 'step', 'investigate', 'Reading the checklist, concept evidence and whiteboard.', clock);
    await call(tools, 'get_session_overview');
    await call(tools, 'get_concept_evidence');
    if (r.boards.some((b) => !b.blank)) await call(tools, 'get_whiteboard_evidence');
  }
  if (tooShort(s)) {
    plog(s, 'decision', 'stop', 'Too little was explained to analyze; nothing saved.', clock);
    return;
  }
  if (!done('get_previous_study_sessions') && (s.input.history?.sessions.length || 0) > 0) {
    plog(s, 'step', 'compare', 'Checking earlier sessions for recurring gaps.', clock);
    await call(tools, 'get_previous_study_sessions', { this_topic_only: true });
  }
  if (!done('rank_knowledge_gaps')) await call(tools, 'rank_knowledge_gaps');
  const top = rankGaps(s)[0];
  if (!top) {
    plog(s, 'decision', 'stop', 'Every checklist concept was demonstrated; no gap to practise.', clock);
    return;
  }
  if (!s.analysis) {
    plog(s, 'decision', 'prioritize', `Priority: ${top.name} (${top.why}).`, clock);
    const desc = (id: string) => {
      const d = r.extraction.concepts.find((x) => x.id === id)?.description || '';
      return d.startsWith('(Added by') ? '' : d;
    };
    const mis = r.learner.concepts.flatMap((x) => x.errors.filter((e) => !e.corrected).map((e) => ({ concept_id: x.id, quote: e.quote, correction: desc(x.id) })));
    await call(tools, 'save_gap_analysis', {
      priority_concept_id: top.conceptId,
      why: `${top.name}: ${top.why}.`,
      misconceptions_json: JSON.stringify(mis.slice(0, 3)),
      missing_concept_ids: r.learner.concepts.filter((x) => x.coverage === 'not_covered').map((x) => x.id),
      unverified_concept_ids: r.learner.concepts.filter((x) => x.coverage !== 'not_covered' && understandingOf(x) !== 'demonstrated').map((x) => x.id),
    });
  }
  if (s.analysis && !s.practice) {
    plog(s, 'step', 'act', 'Saving a practice question for the priority concept.', clock);
    const c = r.learner.concepts.find((x) => x.id === s.analysis!.priority.conceptId)!;
    const err = c.errors.find((e) => !e.corrected);
    const name = c.name;
    const prompt = err
      ? `Last time you said "${err.quote.slice(0, 90)}". Can you explain ${name.toLowerCase()} again, and how you'd check that it's right?`
      : c.coverage === 'not_covered'
        ? `Can you explain ${name.toLowerCase()} to me from the start, with an example?`
        : `Can you explain ${name.toLowerCase()} again, and then tell me what would happen in a situation you haven't used yet?`;
    const d = r.extraction.concepts.find((x) => x.id === c.id)?.description || '';
    const lookFor = d && !d.startsWith('(Added by')
      ? d.split(/;|, and |\. /).map((x) => x.trim().replace(/\.$/, '')).filter((x) => x.length > 3).slice(0, 3)
      : ['An accurate explanation in your own words', 'Why it works the way it does', 'An example or new case'];
    await call(tools, 'save_practice', { kind: err ? 'challenge' : 'question', prompt, look_for: lookFor, concept_id: c.id });
    if (s.practice) (s.practice as Practice).source = 'template';
  }
}

export async function runFallbackPlanner(s: PlannerState, reason: string, clock: () => number = Date.now): Promise<StudyPlan> {
  plog(s, 'decision', 'fallback', reason, clock);
  await completePlan(s, clock);
  return buildPlan(s, 'fallback', reason);
}

