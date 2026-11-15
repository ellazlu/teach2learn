// The coach's tools. Each tool is a plain async function over one session's
// context, so the same tools run under the Deep Agents loop (agent.js) and the
// deterministic fallback (fallback.ts), and can be unit-tested directly.
//
// Every tool returns a JSON string. Problems come back as {"error": ...} with
// a fix hint, so the agent can correct itself instead of the run failing.
// Every call is written to the developer log (name, args, short result, time).

import type { SessionRecord } from '../history.ts';
import type { CoachHistory } from '../progress.ts';
import type { EvidenceItem } from '../student/evidence.ts';
import { cleanText } from '../student/evidence.ts';
import { fmt } from '../student/speech.ts';
import {
  CATEGORIES, CATEGORY_LABEL, RUBRIC_TEXT, SKILLS, SKILL_IDS, factsFrom, scoreSession, weaknesses,
  type Category, type Scores, type SessionFacts, type Skill,
} from './rubric.ts';
import {
  METRIC_IDS, describeCriterion, plainReason, evaluateCriteria, makeAttempt, nextDifficulty, templateDraft, validateChallenge,
  type Challenge, type ChallengeDraft,
} from './challenges.ts';
import type { ChallengeOutcome, CoachLogEntry, CoachResult, CategoryTrend, Evaluation, Verdict } from './types.ts';

export interface CoachInput {
  session: SessionRecord;
  history: CoachHistory | null; // null/empty for a first-time user
  activeChallenge: Challenge | null;
  coachNotes?: string; // the coach's own note from last time (persistent context)
}

export interface CoachState {
  input: CoachInput;
  facts: SessionFacts;
  scores: Scores | null;
  candidates: { skill: Skill; score: number; why: string }[] | null;
  trend: CoachResult['trend'] | null;
  recurring: Skill[];
  outcome: ChallengeOutcome | null;
  outcomeChecked: boolean;
  evaluation: Evaluation | null;
  challenge: Challenge | null;
  noteForNextTime: string;
  log: CoachLogEntry[];
  started: number;
  now: () => string;
  newId: () => string;
}

export type ParamSpec = { type: 'string' | 'number' | 'boolean' | 'string[]'; description: string; optional?: boolean; enum?: string[] };

export interface CoachTool {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  run: (args: any) => Promise<string>;
}

export function createState(input: CoachInput, opts: { now?: () => string; newId?: () => string; clock?: () => number } = {}): CoachState {
  const clock = opts.clock || Date.now;
  return {
    input,
    facts: factsFrom({
      levelId: input.session.levelId,
      utterances: input.session.utterances || [],
      events: input.session.events || [],
      metrics: input.session.metrics || null,
      evidence: input.session.evidence || [],
      finalModel: input.session.finalModel || null,
    }),
    scores: null,
    candidates: null,
    trend: null,
    recurring: [],
    outcome: null,
    outcomeChecked: false,
    evaluation: null,
    challenge: null,
    noteForNextTime: '',
    log: [],
    started: clock(),
    now: opts.now || (() => new Date().toISOString()),
    newId: opts.newId || (() => `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
  };
}

export function log(state: CoachState, type: CoachLogEntry['type'], name: string, detail: string, clock: () => number = Date.now) {
  const entry = { ms: Math.max(0, clock() - state.started), type, name, detail: detail.slice(0, 300) };
  state.log.push(entry);
  if ((globalThis as any).process?.env?.COACH_LOG !== 'off') console.log(`[coach] +${entry.ms}ms ${type} ${name}: ${entry.detail}`);
}

const json = (x: unknown) => JSON.stringify(x);
const err = (message: string) => json({ error: message });
const hasHistory = (s: CoachState) => !!s.input.history && s.input.history.sessions.length > 0;
const attemptedChallenge = (s: CoachState) => {
  const c = s.input.activeChallenge;
  return c && s.input.session.challengeId === c.id ? c : null;
};

const KIND_CATEGORY: Record<string, Category> = {
  question_unanswered: 'engagement', question_partial: 'engagement', question_answered: 'engagement', checked_understanding: 'engagement',
  long_run: 'engagement', no_checks: 'engagement', slow_response: 'engagement',
  undefined_term: 'communication', unclear_explanation: 'communication', pace: 'communication', open_question: 'communication',
  incorrect_explanation: 'teaching', demonstrated: 'teaching', demo_partial: 'teaching', demo_failed: 'teaching',
  misconception_resolved: 'teaching', misconception_partial: 'teaching', misconception_unaddressed: 'teaching',
  mastery_gain: 'teaching', used_example: 'teaching', not_covered: 'teaching',
};

const evidenceView = (e: EvidenceItem) => ({ id: e.id, at: e.at === null ? null : fmt(e.at), category: KIND_CATEGORY[e.kind] || 'teaching', positive: e.positive, what: e.label, quote: e.quote });

// ---- Tool implementations ---------------------------------------------------------------

export function ensureScores(s: CoachState): Scores {
  if (!s.scores) {
    const i = s.input.session;
    s.scores = scoreSession({ levelId: i.levelId, utterances: i.utterances || [], events: i.events || [], metrics: i.metrics || null, evidence: i.evidence || [], finalModel: i.finalModel || null });
  }
  return s.scores;
}

export function allUnrated(s: CoachState) {
  const sc = ensureScores(s);
  return CATEGORIES.every((c) => sc[c].score === null);
}

function computeComparison(s: CoachState) {
  const scores = ensureScores(s);
  const prev = s.input.history?.sessions || [];
  const trend = {} as CoachResult['trend'];
  for (const c of CATEGORIES) {
    const earlier = prev.map((p) => p.ratings?.[c]).filter((v): v is number => typeof v === 'number').slice(-3);
    const previousAvg = earlier.length ? Math.round((earlier.reduce((a, b) => a + b, 0) / earlier.length) * 10) / 10 : null;
    const current = scores[c].score;
    trend[c] = { current, previousAvg, delta: current !== null && previousAvg !== null ? Math.round((current - previousAvg) * 10) / 10 : null } as CategoryTrend;
  }
  const weak = weaknesses(scores);
  const recent = prev.slice(-4);
  const seen = (k: Skill) => recent.filter((p) => (p.weaknesses || []).includes(k)).length;
  const recurring = SKILL_IDS.filter((k) => weak.some((w) => w.skill === k) && seen(k) >= 1);
  const outcomeSkill = s.outcome && s.outcome.verdict !== 'addressed' ? s.outcome.skill : null;
  // Ranking: severity now, plus how often it has recurred, plus a nudge to keep
  // working on a practised skill that isn't fixed yet.
  const candidates = weak
    .map((w) => {
      const r = seen(w.skill);
      const keep = outcomeSkill === w.skill ? 1 : 0;
      const why = [w.text, r ? `also seen in ${r} of the last ${recent.length} sessions` : '', keep ? 'targeted by the last challenge and not yet fixed' : '']
        .filter(Boolean).join('; ');
      return { skill: w.skill, score: Math.round((w.severity + r * 0.75 + keep) * 100) / 100, why };
    })
    .sort((a, b) => b.score - a.score);
  s.trend = trend;
  s.recurring = recurring;
  s.candidates = candidates;
  return { trend, recurring, candidates };
}

function verdictFor(met: number, judged: number, total: number): Verdict {
  if (judged === 0) return 'not_enough_evidence';
  if (met === total) return 'addressed';
  if (met > 0) return 'partly_addressed';
  return 'not_addressed';
}

export function checkChallenge(s: CoachState) {
  const c = attemptedChallenge(s);
  s.outcomeChecked = true;
  if (!c) return null;
  const results = evaluateCriteria(c.criteria, s.facts, ensureScores(s));
  const attempt = makeAttempt(s.input.session.id, s.input.session.createdAt, results);
  const prior = c.attempts.filter((a) => a.sessionId !== attempt.sessionId);
  s.outcome = { challengeId: c.id, skill: c.skill, attempt, verdict: verdictFor(attempt.met, attempt.judged, attempt.total), adjustment: '' };
  return { challenge: c, attempt, prior };
}

export function saveEvaluation(s: CoachState, args: { focus_skill: string; reason: string; evidence_ids?: string[]; note_for_next_time?: string }) {
  if (allUnrated(s)) return { error: 'Not enough evidence in this session to choose a focus. Do not save an evaluation or a challenge; finish now.' };
  if (!s.candidates) computeComparison(s);
  const skill = args?.focus_skill as Skill;
  if (!SKILL_IDS.includes(skill)) return { error: `focus_skill must be one of: ${SKILL_IDS.join(', ')}` };
  const allowed = s.candidates!.length ? s.candidates!.map((c) => c.skill) : SKILL_IDS;
  if (!allowed.includes(skill)) return { error: `focus_skill must be a weakness this session showed: ${allowed.join(', ')}` };
  const reason = plainReason(cleanText(args.reason || ''));
  if (!reason) return { error: 'reason is required: one sentence tied to the evidence' };
  const known = new Set((s.input.session.evidence || []).map((e) => e.id));
  const evidenceIds = (args.evidence_ids || []).map((x) => String(x).toUpperCase()).filter((x) => known.has(x));
  const unknown = (args.evidence_ids || []).filter((x) => !known.has(String(x).toUpperCase()));
  s.evaluation = { focusSkill: skill, reason, evidenceIds };
  s.noteForNextTime = cleanText(args.note_for_next_time || '').slice(0, 240);
  return { saved: true, focus_skill: skill, evidence_ids: evidenceIds, ...(unknown.length ? { ignored_unknown_evidence_ids: unknown } : {}) };
}

export function saveChallenge(s: CoachState, args: Partial<ChallengeDraft> & { retry_previous?: boolean }) {
  if (!s.evaluation) return { error: 'Call save_evaluation first; the challenge must target the saved focus skill.' };
  const active = s.input.activeChallenge;
  if (args?.retry_previous) {
    if (!active) return { error: 'There is no previous challenge to retry. Design a new one instead.' };
    if (s.outcome?.verdict === 'addressed') return { error: 'The previous challenge was fully met; design a new, harder one instead of retrying.' };
    if (active.skill !== s.evaluation.focusSkill) return { error: `The previous challenge targets ${active.skill}, but the saved focus is ${s.evaluation.focusSkill}. Design a new challenge.` };
    s.challenge = { ...active, status: 'active' };
    if (s.outcome) s.outcome.adjustment = 'Kept the same challenge for another attempt.';
    return { saved: true, retry: true, id: active.id, title: active.title, criteria: active.criteria.map(describeCriterion) };
  }
  const skill = args?.skill || s.evaluation.focusSkill;
  if (skill !== s.evaluation.focusSkill) return { error: `skill must match the saved focus skill (${s.evaluation.focusSkill}).` };
  const sess = s.input.session;
  const difficulty = nextDifficulty(active, skill as Skill);
  const draft: ChallengeDraft = {
    skill,
    title: args.title || '',
    goal: args.goal || '',
    student_profile: args.student_profile || '',
    misconception: args.misconception || '',
    topic: args.topic || sess.topicTitle,
    level_id: args.level_id || sess.levelId,
    time_limit_sec: args.time_limit_sec ?? Math.max(60, Math.min(300, sess.timeLimitSec || 120)),
    criteria: args.criteria || [],
    rationale: args.rationale || s.evaluation.reason,
  };
  const v = validateChallenge(draft, { sessionId: sess.id, now: s.now(), id: s.newId(), difficulty, source: 'agent' });
  if (!v.ok) return { error: `Fix and call again: ${v.errors.join('; ')}` };
  s.challenge = v.challenge;
  if (s.outcome) {
    s.outcome.adjustment = s.outcome.skill === skill
      ? s.outcome.verdict === 'addressed' ? 'Same skill, harder challenge.' : 'Same skill, adjusted challenge.'
      : `Moved on to ${SKILLS[skill as Skill].label.toLowerCase()}.`;
  }
  return { saved: true, id: v.challenge.id, difficulty, criteria: v.challenge.criteria.map(describeCriterion), next_session: { topic: v.challenge.scenario.topic, level: v.challenge.scenario.levelId, seconds: v.challenge.scenario.timeLimitSec } };
}

// Deterministic challenge for a skill, through the same validator.
export function templateChallengeArgs(s: CoachState, skill: Skill): ChallengeDraft {
  const sess = s.input.session;
  const mis = sess.finalModel?.misconceptions.find((m) => m.status !== 'resolved')?.belief || '';
  return templateDraft(skill, {
    topic: sess.topicTitle,
    levelId: sess.levelId,
    difficulty: nextDifficulty(s.input.activeChallenge, skill),
    reason: s.evaluation?.reason || '',
    misconception: mis,
  });
}

// ---- Tool definitions -------------------------------------------------------------------

export function createTools(s: CoachState, clock: () => number = Date.now): CoachTool[] {
  const wrap = (name: string, description: string, params: Record<string, ParamSpec>, fn: (a: any) => unknown): CoachTool => ({
    name,
    description,
    params,
    run: async (args: any) => {
      const t0 = clock();
      let out: string;
      try {
        out = json(await fn(args || {}));
      } catch (e: any) {
        out = err(`Tool failed: ${e?.message || e}`);
      }
      const a = args && Object.keys(args).length ? JSON.stringify(args).slice(0, 140) : '';
      log(s, out.startsWith('{"error"') ? 'error' : 'tool', name, `${a ? `args ${a} -> ` : ''}${out.slice(0, 140)} (${clock() - t0}ms)`, clock);
      return out;
    },
  });

  const tools: CoachTool[] = [
    wrap('get_session_overview',
      'Start here. What was taught, to which student level, how long, how much each side spoke, the student\'s end state per concept, whether there is past history, and whether this session was an attempt at a practice challenge.',
      {},
      () => {
        const i = s.input.session;
        const f = s.facts;
        const c = attemptedChallenge(s);
        return {
          topic: i.topicTitle, level: i.levelId, seconds_used: i.timeUsedSec, seconds_allowed: i.timeLimitSec,
          tutor_words: f.teacherWords, student_turns: f.studentTurns,
          concepts: (i.finalModel?.concepts || []).map((x) => ({ name: x.name, explained: x.explained, student_understanding: x.verification || 'not_verified' })),
          misconceptions: (i.finalModel?.misconceptions || []).map((m) => ({ belief: m.belief, voiced_by_student: m.expressed, status: m.status })),
          previous_sessions: s.input.history?.sessions.length || 0,
          attempted_challenge: c ? { id: c.id, skill: c.skill, title: c.title, criteria: c.criteria.map(describeCriterion), previous_attempts: c.attempts.length } : null,
          coach_note_from_last_time: s.input.coachNotes || null,
          too_short_to_rate: f.teacherWords < 40,
        };
      }),
    wrap('get_transcript_evidence',
      'Evidence items (id, time, what happened, quote) found in the session, optionally for one rating category. Cite these ids. Set include_transcript to also get the tutor/student transcript.',
      {
        category: { type: 'string', description: 'engagement, communication, teaching, or all', optional: true, enum: ['engagement', 'communication', 'teaching', 'all'] },
        include_transcript: { type: 'boolean', description: 'also return the transcript (truncated)', optional: true },
      },
      (a) => {
        const ev = (s.input.session.evidence || []).map(evidenceView).filter((e) => !a.category || a.category === 'all' || e.category === a.category);
        const out: any = { evidence: ev };
        if (a.include_transcript) {
          const t = (s.input.session.utterances || []).map((u) => `[${fmt(u.start)}] ${u.speaker === 'teacher' ? 'Tutor' : 'Student'}: ${u.text}`).join('\n');
          out.transcript = t.length > 5000 ? `${t.slice(0, 5000)}\n…(truncated)` : t;
        }
        return out;
      }),
    wrap('calculate_speech_statistics',
      'Speech measurements from timestamps: pace, fillers, longest uninterrupted stretch, check-ins, talk share, response time to student questions. Values are null when they could not be measured. Pauses and accents are never treated as faults.',
      {},
      () => {
        const m = s.input.session.metrics;
        const f = s.facts;
        return {
          words_per_minute: f.wpm,
          fillers_per_minute: f.fillersPerMin,
          longest_stretch_seconds: f.maxRunSec,
          stretches_over_90s: m?.runsOver90s.length ?? null,
          check_ins_or_questions_to_student: f.invitations,
          tutor_share_of_talk: m?.teacherShare ?? null,
          seconds_to_answer_student_questions: m?.responseLatencies.map((r) => r.seconds) ?? [],
          measured: !!m && (m.teacherSpeakingSec || 0) > 0,
        };
      }),
    wrap('score_session',
      'Apply the fixed rubric. Returns the 1-5 rating (or null = not enough evidence) for engagement, communication and teaching effectiveness, each with its explanation and the factors that moved it, plus the weak skills this session showed. Ratings are deterministic; do not re-score them yourself.',
      {},
      () => {
        const sc = ensureScores(s);
        return {
          ratings: Object.fromEntries(CATEGORIES.map((c) => [c, { label: CATEGORY_LABEL[c], score: sc[c].score, explanation: sc[c].explanation, factors: sc[c].factors.map((f) => ({ change: f.delta, what: f.text, skill: f.skill, evidence: f.evidenceIds })) }])),
          weak_skills: weaknesses(sc).map((w) => ({ skill: w.skill, label: SKILLS[w.skill].label, severity: w.severity })),
          all_not_enough_evidence: allUnrated(s),
        };
      }),
    wrap('get_previous_sessions',
      'Earlier sessions for this tutor (oldest first): date, topic, level, ratings, weak skills, the coach\'s focus, and any challenge attempted. Empty for a first-time user.',
      { limit: { type: 'number', description: 'how many recent sessions (default 5)', optional: true } },
      (a) => {
        const list = s.input.history?.sessions || [];
        const n = Math.max(1, Math.min(8, Number(a.limit) || 5));
        return { count: list.length, sessions: list.slice(-n).map((p) => ({ id: p.id, date: p.at.slice(0, 10), topic: p.topic, level: p.levelId, ratings: p.ratings, weak_skills: p.weaknesses, coach_focus: p.focusSkill, challenge: p.challengeId })) };
      }),
    wrap('compare_with_previous',
      'Compare this session with earlier ones: per-category change vs. the average of up to 3 earlier rated sessions, which weak skills are recurring, and a ranked list of candidate focus skills (with reasons). Call after score_session.',
      {},
      () => {
        if (!hasHistory(s)) {
          const r = computeComparison(s);
          return { first_session: true, note: 'No earlier sessions; trends unavailable.', candidates: r.candidates };
        }
        return computeComparison(s);
      }),
    wrap('check_previous_challenge',
      'Only when this session was an attempt at a practice challenge: evaluates each success criterion (met / not met / not enough evidence) with the same measurements as before, and compares with earlier attempts.',
      {},
      () => {
        const r = checkChallenge(s);
        if (!r) return { error: 'This session was not an attempt at a practice challenge; skip this step.' };
        if (s.candidates) computeComparison(s); // re-rank with the outcome
        return {
          challenge: r.challenge.title,
          skill: r.challenge.skill,
          verdict: s.outcome!.verdict,
          criteria: r.attempt.results.map((x) => ({ criterion: describeCriterion(x), actual: x.actual, met: x.met })),
          earlier_attempts: r.prior.map((a) => ({ date: a.at.slice(0, 10), met: a.met, of: a.total })),
        };
      }),
    wrap('save_evaluation',
      'Save the single highest-priority skill for this tutor to work on next, with a one-sentence reason and the evidence ids behind it. Optionally leave a short note for yourself for the next session.',
      {
        focus_skill: { type: 'string', description: 'one skill id', enum: SKILL_IDS },
        reason: { type: 'string', description: 'one plain sentence the tutor will read, specific to this session; put evidence ids in evidence_ids, not here' },
        evidence_ids: { type: 'string[]', description: 'evidence ids (E1, E2, ...) supporting it', optional: true },
        note_for_next_time: { type: 'string', description: 'a short note to read at the start of the next review', optional: true },
      },
      (a) => saveEvaluation(s, a)),
    wrap('save_practice_challenge',
      'Save the next practice session: a realistic student scenario and 1-3 measurable success criteria for the saved focus skill. This becomes the tutor\'s Next Challenge. To retry the previous challenge unchanged, pass retry_previous=true and nothing else. Metrics: ' + METRIC_IDS.join(', ') + '.',
      {
        retry_previous: { type: 'boolean', description: 'reuse the previous challenge for another attempt', optional: true },
        title: { type: 'string', description: 'short name, e.g. "The quiet student"', optional: true },
        goal: { type: 'string', description: 'one sentence the tutor sees during the session', optional: true },
        student_profile: { type: 'string', description: 'how the simulated student behaves (realistic, specific); the student plays this role and the tutor sees it as "Your student"', optional: true },
        misconception: { type: 'string', description: 'a wrong belief the student starts with, if relevant', optional: true },
        topic: { type: 'string', description: 'topic to teach (default: same topic)', optional: true },
        level_id: { type: 'string', description: 'student level (default: same level)', optional: true, enum: ['kindergarten', 'middle', 'high', 'college', 'expert'] },
        time_limit_sec: { type: 'number', description: '60-300 seconds', optional: true },
        criteria_json: { type: 'string', description: 'JSON array of {"metric": <metric id>, "target": <number>}', optional: true },
        rationale: { type: 'string', description: 'why this challenge, tied to evidence', optional: true },
      },
      (a) => {
        let criteria: ChallengeDraft['criteria'] | undefined;
        if (a.criteria_json) {
          try {
            criteria = JSON.parse(a.criteria_json);
          } catch {
            return { error: 'criteria_json must be a JSON array like [{"metric":"check_ins","target":2}]' };
          }
        }
        const { criteria_json: _, ...rest } = a;
        return saveChallenge(s, { ...rest, criteria });
      }),
  ];
  // The challenge check only exists when there is something to check.
  return attemptedChallenge(s) ? tools : tools.filter((t) => t.name !== 'check_previous_challenge');
}

// Assemble the final result from whatever the run saved.
export function buildResult(s: CoachState, agent: CoachResult['agent'], error?: string): CoachResult {
  if (!s.trend) computeComparison(s);
  return {
    sessionId: s.input.session.id,
    ratings: ensureScores(s),
    evaluation: s.evaluation,
    challenge: s.challenge,
    challengeOutcome: s.outcome,
    trend: s.trend!,
    recurring: s.recurring,
    log: s.log,
    coachNote: s.noteForNextTime,
    agent,
    ...(error ? { error } : {}),
  };
}
