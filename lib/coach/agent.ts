// The post-session coach, built on LangChain Deep Agents. Runs after feedback,
// never in the live conversation. The agent plans with Deep Agents' built-in
// todo tool, then decides which of our tools to call and in what order; the
// tools hold all scoring and validation, so ratings stay deterministic while
// the agent does the investigation, diagnosis and challenge design.
//
// If Deep Agents can't run (no API key, package not installed, API error,
// timeout), or stops before saving, the deterministic coach finishes the job.

import { buildResult, checkChallenge, createState, createTools, log, type CoachInput, type CoachState, type CoachTool, type ParamSpec } from './tools.ts';
import { completeDeterministically, runFallbackCoach } from './fallback.ts';
import { SKILLS, SKILL_IDS } from './rubric.ts';
import type { CoachResult } from './types.ts';

export const COACH_PROMPT = `You are a teaching coach reviewing one practice session in which a tutor taught a simulated student. You work after the session, with tools.

Objectives, in order:
1. Investigate: get_session_overview first. Use get_transcript_evidence and calculate_speech_statistics as needed.
2. Analyze: score_session applies the fixed rubric. Never invent or change ratings.
3. Verify: if the overview shows attempted_challenge, call check_previous_challenge. Otherwise do not.
4. Compare: if previous_sessions > 0, call compare_with_previous (and get_previous_sessions if you need detail). For a first session call compare_with_previous once to get the candidate skills.
5. Diagnose: choose ONE focus skill, normally the top-ranked candidate. Prefer a recurring weakness over a one-off. If the previous challenge was not fully met, prefer the same skill unless a more severe problem appeared.
6. Plan and act: save_evaluation (focus_skill, one-sentence reason, evidence ids). Then save_practice_challenge: either retry_previous=true (when the previous challenge was partly or not met and a retry is the best practice), or a new challenge with a realistic student_profile that makes the focus skill necessary, and 1-3 measurable criteria via criteria_json.

Rules:
- If score_session reports all_not_enough_evidence, stop: do not save anything.
- Base everything on tool results; cite evidence ids; do not assume the student learned something because it was explained.
- Never treat accents, pauses or speaking style as weaknesses. More talking or more questions is not automatically better.
- Skill ids: ${SKILL_IDS.map((k) => `${k} (${SKILLS[k].label})`).join(', ')}.
- If a tool returns an error, fix the arguments and call it again.
- Be economical: about 6-10 tool calls. Do not use subagents or files. Plan with write_todos once at the start.
- Finish with one short sentence saying what you saved.`;

export type Deps = { createDeepAgent: any; tool: any; z: any; ChatAnthropic: any; todoListMiddleware?: any };

export async function loadDeps(): Promise<Deps> {
  // Imported lazily (and kept out of the bundle via next.config) so the app
  // still works, with the fallback coach, if these packages aren't installed.
  const [da, lc, zod, anth] = await Promise.all([
    import('deepagents' as string),
    import('langchain' as string),
    import('zod' as string),
    import('@langchain/anthropic' as string),
  ]);
  return { createDeepAgent: da.createDeepAgent, tool: lc.tool, todoListMiddleware: lc.todoListMiddleware, z: zod.z || zod.default, ChatAnthropic: anth.ChatAnthropic };
}

export function zodSchema(z: any, params: Record<string, ParamSpec>) {
  const shape: Record<string, any> = {};
  for (const [k, p] of Object.entries(params)) {
    let t = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : p.type === 'string[]' ? z.array(z.string()) : p.enum ? z.enum(p.enum) : z.string();
    t = t.describe(p.description);
    shape[k] = p.optional ? t.optional() : t;
  }
  return z.object(shape);
}

export function toLangChainTools(deps: Deps, tools: CoachTool[]) {
  return tools.map((t) => deps.tool(async (args: any) => t.run(args), { name: t.name, description: t.description, schema: zodSchema(deps.z, t.params) }));
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: any;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`coach timed out after ${ms}ms`)), ms)))]).finally(() => clearTimeout(timer));
}

// Log the agent's built-in tool calls (planning etc.); our own tools log themselves.
// Only tool names and arguments are logged, never the model's reasoning text.
function logBuiltins(s: CoachState, messages: any[], ours: Set<string>, clock: () => number) {
  for (const m of messages || []) {
    for (const c of m?.tool_calls || []) {
      if (ours.has(c.name)) continue;
      const detail = c.name === 'write_todos' && Array.isArray(c.args?.todos)
        ? `plan: ${c.args.todos.map((t: any) => t.content || t).join(' | ')}`
        : JSON.stringify(c.args || {}).slice(0, 200);
      log(s, 'step', c.name, detail, clock);
    }
  }
}

export interface RunOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  recursionLimit?: number;
  loadDeps?: () => Promise<Deps>;
  clock?: () => number;
  now?: () => string;
  newId?: () => string;
}

export async function runCoach(input: CoachInput, opts: RunOptions = {}): Promise<CoachResult> {
  const clock = opts.clock || Date.now;
  const s = createState(input, { now: opts.now, newId: opts.newId, clock });
  log(s, 'step', 'start', `Reviewing session ${input.session.id} (${input.history?.sessions.length || 0} earlier sessions, ${input.activeChallenge ? 'challenge active' : 'no challenge'}).`, clock);
  if (!opts.apiKey) return runFallbackCoach(s, 'No ANTHROPIC_API_KEY; using the deterministic coach.', clock);

  let deps: Deps;
  try {
    deps = await (opts.loadDeps || loadDeps)();
    if (typeof deps.createDeepAgent !== 'function' || typeof deps.tool !== 'function') throw new Error('unexpected deepagents/langchain exports');
  } catch (e: any) {
    return runFallbackCoach(s, `Deep Agents unavailable (${String(e?.message || e).slice(0, 120)}); using the deterministic coach.`, clock);
  }

  const ours = createTools(s, clock);
  try {
    const model = new deps.ChatAnthropic({ model: opts.model || 'claude-sonnet-5-5', apiKey: opts.apiKey, maxTokens: 2048 });
    const agent = await deps.createDeepAgent({
      model,
      tools: toLangChainTools(deps, ours),
      systemPrompt: COACH_PROMPT,
      middleware: deps.todoListMiddleware ? [deps.todoListMiddleware()] : [],
    });
    log(s, 'step', 'agent', 'Deep Agents run started.', clock);
    const result: any = await withTimeout(
      agent.invoke({ messages: [{ role: 'user', content: `Review session ${input.session.id} and set up the tutor's next practice challenge.` }] }, { recursionLimit: opts.recursionLimit || 40 }),
      opts.timeoutMs || 75000,
    );
    logBuiltins(s, result?.messages, new Set(ours.map((t) => t.name)), clock);
    log(s, 'step', 'agent', `Deep Agents run finished (${result?.messages?.length ?? 0} messages).`, clock);
  } catch (e: any) {
    log(s, 'error', 'agent', String(e?.message || e).slice(0, 200), clock);
    // Keep whatever the agent already saved; finish the rest deterministically.
    await completeDeterministically(s, clock);
    return buildResult(s, 'fallback', `Deep Agents run failed: ${String(e?.message || e).slice(0, 160)}`);
  }

  // Conditional completion: the agent decides, but required outputs must exist.
  const attempted = ours.some((t) => t.name === 'check_previous_challenge');
  if (attempted && !s.outcomeChecked) {
    log(s, 'decision', 'verify', 'Agent skipped the challenge check; running it.', clock);
    checkChallenge(s);
  }
  if (!s.evaluation || !s.challenge) {
    const missing = [!s.evaluation && 'evaluation', !s.challenge && 'challenge'].filter(Boolean).join(' and ');
    log(s, 'decision', 'complete', `Agent finished without saving the ${missing}; completing deterministically.`, clock);
    await completeDeterministically(s, clock);
  }
  return buildResult(s, 'deepagents');
}
