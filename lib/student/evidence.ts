// Evidence-based feedback. Code collects timestamped evidence from the session
// (knowledge events, misconception changes, unanswered questions, speech
// metrics). The LLM may only write suggestions that cite these evidence ids;
// anything uncited is dropped. If the LLM fails, fallbackSuggestions() turns
// the evidence into plain suggestions on its own.

import type { KnowledgeEvent, SpeechMetrics, StudentModel } from './types.ts';
import type { LearningSummary } from './knowledge.ts';
import { getLevel } from '../levels.ts';
import { fmt } from './speech.ts';

export type EvidenceKind =
  | 'undefined_term'
  | 'incorrect_explanation'
  | 'unclear_explanation'
  | 'open_question'
  | 'misconception_resolved'
  | 'misconception_partial'
  | 'misconception_unaddressed'
  | 'question_unanswered'
  | 'question_partial'
  | 'question_answered'
  | 'mastery_gain'
  | 'used_example'
  | 'checked_understanding'
  | 'long_run'
  | 'pace'
  | 'slow_response'
  | 'no_checks'
  | 'not_covered';

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  at: number | null; // seconds into the session, null if not tied to a moment
  label: string; // one factual sentence
  quote: string; // teacher's words, or the student's question
  positive: boolean;
}

export interface Suggestion {
  title: string;
  detail: string;
  evidence: EvidenceItem[];
}

export interface EvidenceInput {
  initial: StudentModel;
  final: StudentModel;
  events: KnowledgeEvent[];
  metrics: SpeechMetrics;
  learning: LearningSummary;
}

const MAX_PER_KIND = 4;

export function buildEvidence({ initial, final, events, metrics, learning }: EvidenceInput): EvidenceItem[] {
  const level = getLevel(final.levelId);
  const items: Omit<EvidenceItem, 'id'>[] = [];
  const name = (id: string | null) => final.concepts.find((c) => c.id === id)?.name || 'this idea';
  const counts: Partial<Record<EvidenceKind, number>> = {};
  const push = (e: Omit<EvidenceItem, 'id'>) => {
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    if (counts[e.kind]! <= MAX_PER_KIND) items.push(e);
  };

  for (const e of events) {
    if (e.type === 'undefined_term') push({ kind: 'undefined_term', at: e.at, label: `Used "${e.term}" without explaining it to ${level.who}.`, quote: e.quote, positive: false });
    if (e.type === 'incorrect_explanation') push({ kind: 'incorrect_explanation', at: e.at, label: `Explanation of ${name(e.conceptId)} doesn't match the material.`, quote: e.quote, positive: false });
    if (e.type === 'unclear_explanation') {
      const what = e.levelFit === 'too_advanced' ? `too advanced for ${level.who}` : 'hard to follow';
      push({ kind: 'unclear_explanation', at: e.at, label: `Explanation of ${name(e.conceptId)} was ${what}${e.gap ? `; it left the student wondering "${e.gap}"` : ''}.`, quote: e.quote, positive: false });
    }
    if (e.type === 'mastery_change' && e.to - e.from >= 8) push({ kind: 'mastery_gain', at: e.at, label: `Student's grasp of ${name(e.conceptId)} rose from ${e.from} to ${e.to} (simulated).`, quote: e.quote, positive: true });
    if (e.type === 'used_example') push({ kind: 'used_example', at: e.at, label: `Used an example or analogy for ${name(e.conceptId)}.`, quote: e.quote, positive: true });
    if (e.type === 'checked_understanding') push({ kind: 'checked_understanding', at: e.at, label: 'Checked whether the student understood.', quote: e.quote, positive: true });
    if (e.type === 'misconception_change') {
      const m = final.misconceptions.find((x) => x.id === e.misconceptionId);
      if (e.to === 'resolved') push({ kind: 'misconception_resolved', at: e.at, label: `Corrected the student's belief that "${m?.belief}".`, quote: e.quote, positive: true });
      if (e.to === 'partially_addressed') push({ kind: 'misconception_partial', at: e.at, label: `Partly addressed the belief that "${m?.belief}", but didn't settle it.`, quote: e.quote, positive: false });
    }
  }

  // Specific questions the student was still left with at the end.
  for (const c of final.concepts) {
    for (const g of c.openGaps || []) {
      push({ kind: 'open_question', at: g.at, label: `By the end, the student was still wondering: "${g.question}" (about ${c.name}).`, quote: g.quote, positive: false });
    }
  }

  for (const m of final.misconceptions) {
    if (m.status === 'resolved' || !m.expressed) continue;
    const q = final.questions.find((x) => x.misconceptionId === m.id);
    push({ kind: 'misconception_unaddressed', at: q?.at ?? null, label: `The student said "${m.belief}" and still believes it. A correct explanation needs: ${m.correction}`, quote: q?.text || '', positive: false });
  }

  for (const q of final.questions) {
    if (q.status === 'answered') push({ kind: 'question_answered', at: q.at, label: `Answered the student's question.`, quote: q.answerQuote || q.text, positive: true });
    if (q.status === 'partially_answered') push({ kind: 'question_partial', at: q.at, label: `Only partly answered the student's question "${q.text}".`, quote: q.text, positive: false });
    if (q.status === 'unanswered' || (q.status === 'pending' && q.segmentsSinceAsked >= 1)) {
      push({ kind: 'question_unanswered', at: q.at, label: `Didn't answer the student's question "${q.text}".`, quote: q.text, positive: false });
    }
  }

  for (const r of metrics.runsOver90s) {
    const checked = metrics.checksForUnderstanding.some((t) => t >= r.start && t <= r.start + r.seconds);
    if (!checked) push({ kind: 'long_run', at: r.start, label: `Spoke for ${r.seconds} seconds straight without checking whether the student was following.`, quote: '', positive: false });
  }
  const fastFor = { kindergarten: 160, middle: 175, high: 190, college: 200, expert: 210 }[level.id];
  if (metrics.wordsPerMinute && metrics.wordsPerMinute > fastFor) {
    push({ kind: 'pace', at: null, label: `Averaged about ${metrics.wordsPerMinute} words per minute while speaking (measured from speech timestamps).`, quote: '', positive: false });
  }
  for (const r of metrics.responseLatencies) {
    if (r.seconds >= 8) push({ kind: 'slow_response', at: r.questionAt, label: `Took ${Math.round(r.seconds)} seconds to start answering the student's question.`, quote: '', positive: false });
  }
  if (metrics.teacherSpeakingSec >= 120 && metrics.checksForUnderstanding.length === 0) {
    push({ kind: 'no_checks', at: null, label: `Never asked whether the student understood during ${Math.round(metrics.teacherSpeakingSec)} seconds of teaching.`, quote: '', positive: false });
  }
  for (const c of learning.notCovered) {
    push({ kind: 'not_covered', at: null, label: `Never got to "${c.name}" from the material.`, quote: '', positive: false });
  }

  void initial; // reserved: initial model kept in the signature for future comparisons
  return items
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    .map((e, i) => ({ ...e, id: `E${i + 1}` }));
}

// Used when the LLM is unavailable: still evidence-based, just plainer.
const FALLBACK: Partial<Record<EvidenceKind, (e: EvidenceItem) => Omit<Suggestion, 'evidence'>>> = {
  incorrect_explanation: (e) => ({ title: 'Double-check this explanation', detail: `${e.label} Re-read that part of your notes and try explaining it again.` }),
  misconception_unaddressed: (e) => ({ title: 'Address the student\'s wrong idea directly', detail: e.label }),
  question_unanswered: (e) => ({ title: 'Answer the student\'s question', detail: `${e.label} Unanswered questions often point to a gap worth reviewing.` }),
  question_partial: (e) => ({ title: 'Finish answering the question', detail: e.label }),
  undefined_term: (e) => ({ title: 'Define terms before using them', detail: e.label }),
  unclear_explanation: (e) => ({ title: 'Make this explanation simpler', detail: `${e.label} Try an everyday example.` }),
  open_question: (e) => ({ title: 'Answer what the student was still wondering', detail: `${e.label} If you can't answer it confidently, that's a gap worth reviewing.` }),
  long_run: (e) => ({ title: 'Check in more often', detail: `${e.label} A quick "does that make sense?" gives the student a chance to tell you they're lost.` }),
  no_checks: (e) => ({ title: 'Check for understanding', detail: e.label }),
  slow_response: (e) => ({ title: 'Review what made you hesitate', detail: `${e.label} Long pauses before answering can be fine, but can also mark something you're unsure about.` }),
  not_covered: (e) => ({ title: 'Cover the rest of the material', detail: e.label }),
  pace: (e) => ({ title: 'Consider slowing down around new ideas', detail: `${e.label} That isn't wrong in itself, but new terms land better with a little room around them.` }),
};

export function fallbackSuggestions(evidence: EvidenceItem[], max = 5): Suggestion[] {
  const out: Suggestion[] = [];
  const uncovered = evidence.filter((e) => e.kind === 'not_covered');
  for (const e of evidence) {
    const f = FALLBACK[e.kind];
    if (!f || e.positive || e.kind === 'not_covered') continue;
    out.push({ ...f(e), evidence: [e] });
  }
  if (uncovered.length) {
    const names = uncovered.map((e) => e.label.match(/"(.+)"/)?.[1] || e.label);
    out.push({ title: 'Cover the rest of the material', detail: `You didn't get to ${names.join(', ')}. Teaching those next would show you whether you really know them.`, evidence: uncovered });
  }
  return out.slice(0, max);
}

export interface RawLLMSuggestion {
  title: string;
  detail: string;
  evidence_ids: string[];
}

// Keep only suggestions that cite real evidence; attach that evidence.
export function attachEvidence(raw: RawLLMSuggestion[] | null | undefined, evidence: EvidenceItem[]): Suggestion[] {
  const byId = new Map(evidence.map((e) => [e.id.toUpperCase(), e]));
  return (raw || [])
    .map((s) => ({
      title: String(s.title || '').trim(),
      detail: String(s.detail || '').trim(),
      evidence: [...new Set((s.evidence_ids || []).map((id) => String(id).toUpperCase()))].map((id) => byId.get(id)).filter((e): e is EvidenceItem => !!e),
    }))
    .filter((s) => s.title && s.detail && s.evidence.length > 0);
}

export function evidenceForPrompt(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) => `${e.id} [${e.at === null ? 'whole session' : fmt(e.at)}] (${e.positive ? 'went well' : 'issue'}) ${e.label}${e.quote ? ` Quote: "${e.quote}"` : ''}`)
    .join('\n');
}
