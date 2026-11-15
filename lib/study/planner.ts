// Teach to Learn: post-session knowledge-gap analysis and study planning on
// LangChain Deep Agents (same runtime as the Learn to Teach coach, separate
// prompt, tools and storage). Runs after feedback, never during the session.
//
// If Deep Agents can't run, or stops before saving, the deterministic planner
// finishes with the same tools and fixed rules.

import { loadDeps, toLangChainTools, withTimeout, type Deps, type RunOptions } from '../coach/agent.ts';
import { buildPlan, createPlannerState, createPlannerTools, plog, rankGaps, type PlannerInput, type PlannerState } from './tools.ts';
import { completePlan, runFallbackPlanner, tooShort } from './fallback.ts';
import type { StudyPlan } from './types.ts';

export { runFallbackPlanner };

export const STUDY_PROMPT = `You analyze one "Teach to Learn" session: someone explained a topic out loud to a simulated student to test their OWN understanding. You work after the session, with tools. Your job is to find their most important knowledge gap and set one targeted practice item.

Objectives:
1. Investigate: get_session_overview first. Then get_concept_evidence (all concepts, or the ones that matter), get_whiteboard_evidence if there were snapshots, and search_material when you need to check whether something they said is accurate.
2. Evaluate: decide which explanations were accurate, which statements were wrong (misconceptions), what was missing, and what was discussed but never shown to be understood. Use only their own words and drawings as evidence.
3. Compare: if there were earlier sessions, call get_previous_study_sessions to see recurring gaps and earlier practice.
4. Prioritize: rank_knowledge_gaps, then pick ONE priority (normally the top; prefer a recurring gap or an uncorrected error over an uncovered detail).
5. Act: save_gap_analysis, then save_practice: one question or short challenge for the priority concept, in a curious student's voice, that makes them explain or apply it (e.g. a new scenario). It must not contain the answer.

Rules:
- Never claim mastery or invent progress; one session is evidence about that session only. Explaining something is not the same as understanding it.
- Misconceptions must quote their exact words.
- If the overview says too_short, or rank_knowledge_gaps returns nothing, stop without saving.
- If a tool returns an error, fix the arguments and call it again.
- Be economical: about 6-10 tool calls. Do not use subagents or files. Plan with write_todos once at the start.
- Finish with one short sentence saying what you saved.`;

function logBuiltins(s: PlannerState, messages: any[], ours: Set<string>, clock: () => number) {
  for (const m of messages || []) {
    for (const c of m?.tool_calls || []) {
      if (ours.has(c.name)) continue;
      const detail = c.name === 'write_todos' && Array.isArray(c.args?.todos) ? `plan: ${c.args.todos.map((t: any) => t.content || t).join(' | ')}` : JSON.stringify(c.args || {}).slice(0, 200);
      plog(s, 'step', c.name, detail, clock);
    }
  }
}

export async function runStudyPlanner(input: PlannerInput, opts: RunOptions = {}): Promise<StudyPlan> {
  const clock = opts.clock || Date.now;
  const s = createPlannerState(input, { now: opts.now, newId: opts.newId, clock });
  plog(s, 'step', 'start', `Analyzing session ${input.session.id} (${input.history?.sessions.length || 0} earlier study sessions${input.session.practiceId ? ', practice attempt' : ''}).`, clock);
  if (!opts.apiKey) return runFallbackPlanner(s, 'No ANTHROPIC_API_KEY; using the deterministic planner.', clock);
  let deps: Deps;
  try {
    deps = await (opts.loadDeps || loadDeps)();
    if (typeof deps.createDeepAgent !== 'function' || typeof deps.tool !== 'function') throw new Error('unexpected deepagents/langchain exports');
  } catch (e: any) {
    return runFallbackPlanner(s, `Deep Agents unavailable (${String(e?.message || e).slice(0, 120)}); using the deterministic planner.`, clock);
  }
  const ours = createPlannerTools(s, clock);
  try {
    const model = new deps.ChatAnthropic({ model: opts.model || 'claude-sonnet-5-5', apiKey: opts.apiKey, maxTokens: 2048 });
    const agent = await deps.createDeepAgent({
      model,
      tools: toLangChainTools(deps, ours),
      systemPrompt: STUDY_PROMPT,
      middleware: deps.todoListMiddleware ? [deps.todoListMiddleware()] : [],
    });
    plog(s, 'step', 'agent', 'Deep Agents run started.', clock);
    const result: any = await withTimeout(
      agent.invoke({ messages: [{ role: 'user', content: `Analyze Teach to Learn session ${input.session.id} and set the next practice item.` }] }, { recursionLimit: opts.recursionLimit || 40 }),
      opts.timeoutMs || 75000,
    );
    logBuiltins(s, result?.messages, new Set(ours.map((t) => t.name)), clock);
    plog(s, 'step', 'agent', `Deep Agents run finished (${result?.messages?.length ?? 0} messages).`, clock);
  } catch (e: any) {
    plog(s, 'error', 'agent', String(e?.message || e).slice(0, 200), clock);
    await completePlan(s, clock);
    return buildPlan(s, 'fallback', `Deep Agents run failed: ${String(e?.message || e).slice(0, 160)}`);
  }
  if (!tooShort(s) && rankGaps(s).length && (!s.analysis || !s.practice)) {
    plog(s, 'decision', 'complete', `Agent finished without saving the ${[!s.analysis && 'analysis', !s.practice && 'practice'].filter(Boolean).join(' and ')}; completing deterministically.`, clock);
    await completePlan(s, clock);
  }
  return buildPlan(s, 'deepagents');
}
