// Teach to Learn study planner tools. Plain functions over one session's
// context, shared by the Deep Agents planner (agent.ts) and the deterministic
// fallback (fallback.ts). Each returns JSON; problems come back as
// {"error": ...} with a fix hint. Every call is logged (no model reasoning).

import type { CoachTool, ParamSpec } from '../coach/tools.ts';
import { fmt } from '../student/speech.ts';
import { normalize, quoteAppearsIn } from '../verify.ts';
import { understandingOf, understandingNote } from '../learner/tracker.ts';
import { reviewCandidates, type ReviewCandidate } from '../learner/feedback.ts';
import type { Understanding } from '../learner/types.ts';
import type { PlannerHistory } from './progress.ts';
import type { GapAnalysis, Practice, StudyPlan, StudyRecord } from './types.ts';
import { recurringGaps, type StudyProfile } from './progress.ts';

export interface PlannerInput {
  session: StudyRecord;
  history: PlannerHistory | null;
  material?: string; // text of uploaded notes, if any (PDF text isn't available here)
  note?: string; // the planner's note from last time
}

export interface PlannerState {
  input: PlannerInput;
  recurring: string[];
  candidates: ReviewCandidate[] | null;
  analysis: GapAnalysis | null;
  practice: Practice | null;
  practiceOutcome: StudyPlan['practiceOutcome'];
  note: string;
  log: StudyPlan['log'];
  started: number;
  now: () => string;
  newId: () => string;
}

export function createPlannerState(input: PlannerInput, opts: { now?: () => string; newId?: () => string; clock?: () => number } = {}): PlannerState {
  const s = input.session;
  const prior = { version: 1, sessions: input.history?.sessions || [], practice: [], currentPracticeId: null, note: '', lastLog: null } as StudyProfile;
  const active = input.history?.practice.find((p) => p.id === s.practiceId);
  const practiced = active && s.learner.concepts.find((c) => c.id === active.conceptId);
  return {
    input,
    recurring: recurringGaps(prior, s.topicKey, s.id),
    candidates: null,
    analysis: null,
    practice: null,
    practiceOutcome: active && practiced ? { practiceId: active.id, understanding: understandingOf(practiced) } : null,
    note: '',
    log: [],
    started: (opts.clock || Date.now)(),
    now: opts.now || (() => new Date().toISOString()),
    newId: opts.newId || (() => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
  };
}

export function plog(s: PlannerState, type: StudyPlan['log'][number]['type'], name: string, detail: string, clock: () => number = Date.now) {
  const e = { ms: Math.max(0, clock() - s.started), type, name, detail: detail.slice(0, 300) };
  s.log.push(e);
  if ((globalThis as any).process?.env?.COACH_LOG !== 'off') console.log(`[study] +${e.ms}ms ${type} ${name}: ${e.detail}`);
}

const userText = (r: StudyRecord) =>
  [...r.utterances.filter((u) => u.speaker === 'teacher').map((u) => u.text), ...r.boards.map((b) => `${b.transcription} ${b.description}`)].join(' ');

export function rankGaps(s: PlannerState): ReviewCandidate[] {
  if (!s.candidates) s.candidates = reviewCandidates(s.input.session.learner, s.input.session.extraction, s.recurring);
  return s.candidates;
}

export function saveGapAnalysis(s: PlannerState, a: { priority_concept_id: string; why: string; misconceptions_json?: string; missing_concept_ids?: string[]; unverified_concept_ids?: string[] }) {
  const L = s.input.session.learner;
  const cands = rankGaps(s);
  if (!cands.length) return { error: 'Every checklist concept was demonstrated: nothing to prioritize. Skip saving and finish.' };
  const id = String(a?.priority_concept_id || '').toLowerCase();
  const allowed = cands.slice(0, 5).map((c) => c.conceptId);
  if (!allowed.includes(id)) return { error: `priority_concept_id must be one of the top-ranked gaps: ${allowed.join(', ')}` };
  const why = String(a.why || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!why) return { error: 'why is required: one sentence tied to what they said.' };
  const name = (cid: string) => L.concepts.find((c) => c.id === cid)?.name || '';
  let mis: GapAnalysis['misconceptions'] = [];
  const rejected: string[] = [];
  if (a.misconceptions_json) {
    let list: any[];
    try {
      list = JSON.parse(a.misconceptions_json);
      if (!Array.isArray(list)) throw new Error();
    } catch {
      return { error: 'misconceptions_json must be a JSON array like [{"concept_id":"c2","quote":"their exact words","correction":"short accurate version"}]' };
    }
    const said = userText(s.input.session);
    for (const m of list.slice(0, 4)) {
      const cid = String(m?.concept_id || '').toLowerCase();
      const quote = String(m?.quote || '').trim();
      if (!name(cid) || !quote || !quoteAppearsIn(quote, said, 0.75)) {
        rejected.push(quote.slice(0, 40) || '(empty)');
        continue;
      }
      mis.push({ conceptId: cid, name: name(cid), quote: quote.slice(0, 200), correction: String(m?.correction || '').trim().slice(0, 200) });
    }
  }
  const ids = (xs: unknown, ok: (u: Understanding, cov: string) => boolean) =>
    (Array.isArray(xs) ? xs : []).map((x) => String(x).toLowerCase()).filter((x) => {
      const c = L.concepts.find((y) => y.id === x);
      return c && ok(understandingOf(c), c.coverage);
    });
  s.analysis = {
    priority: { conceptId: id, name: name(id), why },
    misconceptions: mis,
    missing: ids(a.missing_concept_ids, (_u, cov) => cov === 'not_covered').map(name),
    unverified: ids(a.unverified_concept_ids, (u, cov) => u !== 'demonstrated' && cov !== 'not_covered').map(name),
  };
  return { saved: true, priority: name(id), ...(rejected.length ? { rejected_misconceptions_not_in_their_words: rejected } : {}) };
}

export function savePractice(s: PlannerState, a: { kind?: string; prompt?: string; look_for?: string[]; concept_id?: string }) {
  if (!s.analysis) return { error: 'Call save_gap_analysis first; the practice must target the saved priority concept.' };
  const r = s.input.session;
  const cid = String(a?.concept_id || s.analysis.priority.conceptId).toLowerCase();
  if (cid !== s.analysis.priority.conceptId) return { error: `concept_id must be the saved priority (${s.analysis.priority.conceptId}).` };
  const prompt = String(a?.prompt || '').replace(/\s+/g, ' ').trim();
  if (prompt.length < 15 || prompt.length > 300) return { error: 'prompt must be 15-300 characters: one question or short challenge, spoken by the student.' };
  const hidden = r.extraction.concepts.find((c) => c.id === cid)?.description || '';
  if (hidden && !hidden.startsWith('(Added by') && quoteAppearsIn(hidden, prompt, 0.6)) return { error: 'The prompt gives away the answer. Ask, do not tell.' };
  const lookFor = (Array.isArray(a?.look_for) ? a.look_for : []).map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 4);
  if (!lookFor.length) return { error: 'look_for needs 1-4 short points a complete answer would cover.' };
  const kind = a?.kind === 'challenge' ? 'challenge' : 'question';
  s.practice = {
    id: s.newId(),
    createdAt: s.now(),
    fromSessionId: r.id,
    topic: r.topicTitle,
    topicKey: r.topicKey,
    levelId: r.levelId,
    conceptId: cid,
    conceptName: s.analysis.priority.name,
    kind,
    prompt,
    lookFor,
    status: 'open',
    attempts: [],
    source: 'agent',
  };
  return { saved: true, id: s.practice.id, next_session: { topic: r.topicTitle, opens_with: prompt } };
}

// Simple keyword retrieval over the uploaded notes (if any).
export function searchMaterial(material: string, query: string, max = 3): string[] {
  const words = new Set(normalize(query).split(' ').filter((w) => w.length > 3));
  if (!material || !words.size) return [];
  const paras = material.split(/\n\s*\n|(?<=\.)\s+(?=[A-Z])/).map((p) => p.trim()).filter((p) => p.length > 30);
  return paras
    .map((p) => ({ p, n: normalize(p).split(' ').filter((w) => words.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((x) => x.p.slice(0, 500));
}

export function createPlannerTools(s: PlannerState, clock: () => number = Date.now): CoachTool[] {
  const r = s.input.session;
  const L = r.learner;
  const wrap = (name: string, description: string, params: Record<string, ParamSpec>, fn: (a: any) => unknown): CoachTool => ({
    name,
    description,
    params,
    run: async (args: any) => {
      const t0 = clock();
      let out: string;
      try {
        out = JSON.stringify(await fn(args || {}));
      } catch (e: any) {
        out = JSON.stringify({ error: `Tool failed: ${e?.message || e}` });
      }
      const a = args && Object.keys(args).length ? JSON.stringify(args).slice(0, 140) : '';
      plog(s, out.startsWith('{"error"') ? 'error' : 'tool', name, `${a ? `args ${a} -> ` : ''}${out.slice(0, 140)} (${clock() - t0}ms)`, clock);
      return out;
    },
  });
  const cName = (id: string) => L.concepts.find((c) => c.id === id)?.name || id;
  const practiced = s.input.history?.practice.find((p) => p.id === r.practiceId) || null;

  const tools: CoachTool[] = [
    wrap('get_session_overview',
      'Start here. Topic, whether notes were uploaded, the concept checklist with each concept\'s tracked status, counts of explanations, follow-up questions and errors, whiteboard use, earlier sessions, and whether this session was a practice attempt.',
      {},
      () => ({
        topic: r.topicTitle,
        from_uploaded_notes: r.extraction.fromMaterial,
        notes_text_available: !!s.input.material,
        explained_to: r.levelId,
        seconds_used: r.timeUsedSec,
        checklist: L.concepts.map((c) => ({ id: c.id, name: c.name, status: understandingOf(c), note: understandingNote(c), explanations: c.explanations.length, followups: c.probes.length, uncorrected_errors: c.errors.filter((e) => !e.corrected).length })),
        whiteboard_snapshots: r.boards.filter((b) => !b.blank).length,
        earlier_sessions: s.input.history?.sessions.length || 0,
        earlier_sessions_on_this_topic: (s.input.history?.sessions || []).filter((x) => x.topicKey === r.topicKey).length,
        practice_attempt: practiced ? { concept: practiced.conceptName, question: practiced.prompt, result: s.practiceOutcome?.understanding || null } : null,
        planner_note_from_last_time: s.input.note || null,
        too_short: r.utterances.filter((u) => u.speaker === 'teacher').reduce((n, u) => n + u.text.split(/\s+/).length, 0) < 25,
      })),
    wrap('get_concept_evidence',
      'Everything tracked for one concept (or all if omitted): their explanations with accuracy judgments, the student\'s follow-up questions and how they answered, errors (and whether they corrected them), details left open, and their transcript lines about it.',
      { concept_id: { type: 'string', description: 'concept id, e.g. c2', optional: true } },
      (a) => {
        const list = a.concept_id ? L.concepts.filter((c) => c.id === String(a.concept_id).toLowerCase()) : L.concepts;
        if (!list.length) return { error: `unknown concept_id; use one of ${L.concepts.map((c) => c.id).join(', ')}` };
        return list.map((c) => {
          const terms = [c.name, ...(r.extraction.concepts.find((x) => x.id === c.id)?.keyTerms || [])].map(normalize).filter((t) => t.length > 3);
          const lines = r.utterances.filter((u) => u.speaker === 'teacher' && terms.some((t) => normalize(u.text).includes(t))).slice(-4).map((u) => `[${fmt(u.start)}] ${u.text}`);
          return {
            id: c.id,
            name: c.name,
            status: understandingOf(c),
            explanations: c.explanations.map((e) => ({ at: fmt(e.at), quote: e.quote, accuracy: e.correctness, clarity: e.clarity, from: e.source })),
            followups: c.probes.map((p) => ({ question: p.text, kind: p.type, answered: p.answer, correct: p.correct, their_answer: p.quote })),
            errors: c.errors.map((e) => ({ quote: e.quote, kind: e.kind, corrected: e.corrected, from: e.source })),
            left_open: c.omissions.map((o) => o.question),
            transcript: lines,
          };
        });
      }),
    wrap('get_whiteboard_evidence',
      'What they wrote and drew on the whiteboard (as read from snapshots), which concepts it relates to, and anything that could not be read.',
      {},
      () => ({ snapshots: r.boards.filter((b) => !b.blank).map((b) => ({ at: fmt(b.at), written: b.transcription, drawn: b.description, concepts: b.conceptIds.map(cName), unreadable: b.unclear.map((u) => u.part) })) })),
    wrap('search_material',
      'Search the uploaded notes for what they say about something, to check an explanation\'s accuracy. If no notes text is available, returns the hidden concept notes instead.',
      { query: { type: 'string', description: 'a few keywords' } },
      (a) => {
        const hits = searchMaterial(s.input.material || '', String(a.query || ''));
        if (hits.length) return { passages: hits };
        return { available: !!s.input.material, concept_notes: r.extraction.concepts.map((c) => ({ id: c.id, name: c.name, should_cover: c.description })) };
      }),
    wrap('get_previous_study_sessions',
      'Earlier Teach to Learn sessions: topic, date, what was demonstrated, what remained a gap, and earlier practice questions. Empty for a first session.',
      { this_topic_only: { type: 'boolean', description: 'only sessions on this topic', optional: true } },
      (a) => {
        const list = (s.input.history?.sessions || []).filter((x) => !a.this_topic_only || x.topicKey === r.topicKey);
        return {
          count: list.length,
          sessions: list.slice(-6).map((x) => ({ date: x.at.slice(0, 10), topic: x.topic, demonstrated: x.concepts.filter((c) => c.understanding === 'demonstrated').map((c) => c.name), gaps: x.gaps, misconceptions: x.misconceptions.map((m) => `${m.name}: "${m.quote}"`) })),
          gaps_seen_before_on_this_topic: s.recurring,
          practice: (s.input.history?.practice || []).map((p) => ({ concept: p.conceptName, question: p.prompt, attempts: p.attempts.map((x) => x.understanding), status: p.status })),
        };
      }),
    wrap('rank_knowledge_gaps',
      'Rank the concepts that are not yet demonstrated by importance: uncorrected errors first, then foundations that later ideas build on, then follow-ups not answered, then uncovered items; gaps seen in earlier sessions rank higher. Choose the priority from this list.',
      {},
      () => ({ ranked: rankGaps(s).map((c) => ({ concept_id: c.conceptId, name: c.name, why: c.why, weight: c.score })) })),
    wrap('save_gap_analysis',
      'Save the analysis: the single priority concept (from rank_knowledge_gaps), one sentence why, any misconceptions as their EXACT words with a short accurate correction, and which concepts were missing or unverified.',
      {
        priority_concept_id: { type: 'string', description: 'concept id from rank_knowledge_gaps' },
        why: { type: 'string', description: 'one sentence tied to what they said' },
        misconceptions_json: { type: 'string', description: 'JSON array of {"concept_id","quote" (their exact words),"correction"}', optional: true },
        missing_concept_ids: { type: 'string[]', description: 'concepts not covered', optional: true },
        unverified_concept_ids: { type: 'string[]', description: 'concepts discussed but not shown to be understood', optional: true },
      },
      (a) => saveGapAnalysis(s, a)),
    wrap('save_practice',
      'Save one targeted practice item for the priority concept. The student will open the next session by asking it, so write it as the student would say it. It must make them explain or apply the idea, never give the answer. look_for lists 1-4 points a complete answer covers (shown to them only afterwards).',
      {
        kind: { type: 'string', description: 'question or challenge', enum: ['question', 'challenge'] },
        prompt: { type: 'string', description: 'the question/challenge, 15-300 characters' },
        look_for: { type: 'string[]', description: '1-4 short points a complete answer includes' },
        concept_id: { type: 'string', description: 'the saved priority concept id', optional: true },
      },
      (a) => savePractice(s, a)),
  ];
  return tools;
}

export function buildPlan(s: PlannerState, agent: StudyPlan['agent'], error?: string): StudyPlan {
  return {
    sessionId: s.input.session.id,
    analysis: s.analysis,
    practice: s.practice,
    practiceOutcome: s.practiceOutcome,
    recurring: s.recurring.filter((n) => s.input.session.learner.concepts.some((c) => c.name.toLowerCase() === n.toLowerCase() && understandingOf(c) !== 'demonstrated')),
    note: s.note,
    log: s.log,
    agent,
    ...(error ? { error } : {}),
  };
}
