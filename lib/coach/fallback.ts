// Deterministic coach: the same investigate -> analyze -> compare -> diagnose ->
// plan -> act -> verify steps, using the same tools, with fixed decision rules.
// Runs when the Deep Agents path is unavailable (no key, package missing, API
// error, timeout) and to finish any step the agent left undone.

import { CATEGORIES, SKILLS, SKILL_IDS, type Skill } from './rubric.ts';
import { allUnrated, buildResult, createTools, log, templateChallengeArgs, type CoachState, type CoachTool } from './tools.ts';
import type { CoachResult } from './types.ts';
import type { Challenge } from './challenges.ts';

const MAX_RETRIES = 2; // attempts at one challenge before switching to a fresh one

async function call(tools: CoachTool[], name: string, args: object = {}) {
  const t = tools.find((x) => x.name === name);
  return t ? JSON.parse(await t.run(args)) : null;
}

// Complete whatever is missing in `s` (all of it, for a fresh state).
export async function completeDeterministically(s: CoachState, clock: () => number = Date.now): Promise<void> {
  const tools = createTools(s, clock);
  const has = (n: string) => s.log.some((e) => e.name === n && e.type === 'tool');

  if (!has('get_session_overview')) {
    log(s, 'step', 'investigate', 'Reading the session overview, evidence and speech statistics.', clock);
    await call(tools, 'get_session_overview');
    await call(tools, 'get_transcript_evidence', { category: 'all' });
    await call(tools, 'calculate_speech_statistics');
  }
  if (!s.scores) {
    log(s, 'step', 'analyze', 'Scoring against the three rubrics.', clock);
    await call(tools, 'score_session');
  }
  if (allUnrated(s)) {
    log(s, 'decision', 'stop', 'Not enough evidence to rate this session; keeping the current challenge unchanged.', clock);
    return;
  }
  if (!s.outcomeChecked && tools.some((t) => t.name === 'check_previous_challenge')) {
    log(s, 'step', 'verify', 'This session attempted a challenge; checking its success criteria.', clock);
    await call(tools, 'check_previous_challenge');
  }
  if (!s.candidates) {
    const first = !s.input.history?.sessions.length;
    log(s, 'step', 'compare', first ? 'First session: no history to compare against.' : 'Comparing with previous sessions.', clock);
    if (!first) await call(tools, 'get_previous_sessions', { limit: 5 });
    await call(tools, 'compare_with_previous');
  }

  if (!s.evaluation) {
    let skill: Skill;
    let reason: string;
    const top = s.candidates![0];
    if (top) {
      skill = top.skill;
      reason = top.why;
    } else {
      // No weaknesses: stretch the lowest-rated category.
      const sc = s.scores!;
      const low = CATEGORIES.filter((c) => sc[c].score !== null).sort((a, b) => sc[a].score! - sc[b].score!)[0];
      skill = SKILL_IDS.find((k) => SKILLS[k].category === low) || 'building_understanding';
      reason = `No clear weaknesses this session; stretching ${SKILLS[skill].label.toLowerCase()}.`;
    }
    log(s, 'decision', 'diagnose', `Focus: ${skill} (${top ? `ranked first, score ${top.score}` : 'stretch goal'}).`, clock);
    const ids = s.scores ? CATEGORIES.flatMap((c) => s.scores![c].factors.filter((f) => f.skill === skill).flatMap((f) => f.evidenceIds)) : [];
    await call(tools, 'save_evaluation', { focus_skill: skill, reason, evidence_ids: [...new Set(ids)].slice(0, 4) });
  }

  if (s.evaluation && !s.challenge) {
    const active = s.input.activeChallenge;
    const o = s.outcome;
    const tries = active ? active.attempts.filter((a) => a.sessionId !== s.input.session.id).length + (o ? 1 : 0) : 0;
    const retry = !!active && !!o && active.skill === s.evaluation.focusSkill && (o.verdict === 'partly_addressed' || o.verdict === 'not_addressed') && tries < MAX_RETRIES;
    log(s, 'decision', 'plan', retry ? `Previous challenge ${o!.verdict.replace('_', ' ')} on attempt ${tries}; retrying it.` : 'Creating a new challenge from the template for the focus skill.', clock);
    log(s, 'step', 'act', 'Saving the evaluation and the next practice session.', clock);
    if (retry) await call(tools, 'save_practice_challenge', { retry_previous: true });
    else {
      const d = templateChallengeArgs(s, s.evaluation.focusSkill);
      const r = await call(tools, 'save_practice_challenge', { ...d, criteria_json: JSON.stringify(d.criteria), criteria: undefined, skill: undefined });
      if (r?.error) log(s, 'error', 'template_challenge', r.error, clock);
      else if (s.challenge) (s.challenge as Challenge).source = 'template';
    }
  }
}

export async function runFallbackCoach(s: CoachState, reason: string, clock: () => number = Date.now): Promise<CoachResult> {
  log(s, 'decision', 'fallback', reason, clock);
  await completeDeterministically(s, clock);
  return buildResult(s, 'fallback', reason);
}
