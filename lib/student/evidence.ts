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
  | 'shallow_explanation'
  | 'accurate_explanation'
  | 'unclear_explanation'
  | 'open_question'
  | 'demonstrated'
  | 'demo_partial'
  | 'demo_failed'
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
    if (e.type === 'shallow_explanation') push({ kind: 'shallow_explanation', at: e.at, label: `Explanation of ${name(e.conceptId)} was accurate but incomplete: it missed an essential part or the reason behind it${e.gap ? ` (left open: "${e.gap}")` : ''}.`, quote: e.quote, positive: false });
    if (e.type === 'accurate_explanation') push({ kind: 'accurate_explanation', at: e.at, label: `Explained ${name(e.conceptId)} accurately, covering the essential idea.`, quote: e.quote, positive: true });
    if (e.type === 'incorrect_explanation') push({ kind: 'incorrect_explanation', at: e.at, label: `Explanation of ${name(e.conceptId)} doesn't match the material.`, quote: e.quote, positive: false });
    if (e.type === 'unclear_explanation') {
      const what = e.levelFit === 'too_advanced' ? `too advanced for ${level.who}` : 'hard to follow';
      push({ kind: 'unclear_explanation', at: e.at, label: `Explanation of ${name(e.conceptId)} was ${what}${e.gap ? `; it left the student wondering "${e.gap}"` : ''}.`, quote: e.quote, positive: false });
    }
    if (e.type === 'mastery_change' && e.to - e.from >= 8) push({ kind: 'mastery_gain', at: e.at, label: `Student's grasp of ${name(e.conceptId)} rose from ${e.from} to ${e.to} (simulated).`, quote: e.quote, positive: true });
    if (e.type === 'used_example') push({ kind: 'used_example', at: e.at, label: `Used an example or analogy for ${name(e.conceptId)}.`, quote: e.quote, positive: true });
    if (e.type === 'checked_understanding') push({ kind: 'checked_understanding', at: e.at, label: 'Checked whether the student understood.', quote: e.quote, positive: true });
    if (e.type === 'demonstration') {
      const how = e.mode === 'apply' ? 'applied' : e.mode === 'answer' ? 'answered a question about' : 'explained back';
      if (e.verdict === 'demonstrated') push({ kind: 'demonstrated', at: e.at, label: `The student correctly ${how} ${name(e.conceptId)}.`, quote: e.text, positive: true });
      else if (e.verdict === 'partial') push({ kind: 'demo_partial', at: e.at, label: `The student only partly ${how} ${name(e.conceptId)}: ${e.note}`, quote: e.text, positive: false });
      else push({ kind: 'demo_failed', at: e.at, label: `The student ${how} ${name(e.conceptId)} incorrectly: ${e.note}`, quote: e.text, positive: false });
    }
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

// ---- Three-item feedback -----------------------------------------------------------

export interface FeedbackItem {
  text: string;
  evidence: EvidenceItem | null;
}

export interface ThreeItems {
  went_well: FeedbackItem | null;
  improve: FeedbackItem | null;
  try_next: FeedbackItem | null;
}

// Most meaningful first.
export const STRENGTH_ORDER: EvidenceKind[] = ['misconception_resolved', 'demonstrated', 'question_answered', 'accurate_explanation', 'checked_understanding', 'used_example', 'mastery_gain'];
export const WEAKNESS_ORDER: EvidenceKind[] = [
  'incorrect_explanation',
  'misconception_unaddressed',
  'shallow_explanation',
  'demo_failed',
  'question_unanswered',
  'open_question',
  'demo_partial',
  'question_partial',
  'undefined_term',
  'unclear_explanation',
  'misconception_partial',
  'no_checks',
  'long_run',
  'slow_response',
  'not_covered',
  'pace',
];

const pick = (evidence: EvidenceItem[], order: EvidenceKind[]) => {
  for (const k of order) {
    const e = evidence.find((x) => x.kind === k);
    if (e) return e;
  }
  return null;
};

const WELL: Partial<Record<EvidenceKind, string>> = {
  misconception_resolved: 'You directly corrected the student\'s wrong idea, and it stuck.',
  demonstrated: 'Your explanation landed: the student could put it in their own words correctly.',
  question_answered: "You answered the student's question directly instead of moving on.",
  checked_understanding: 'You stopped to check whether the student was following.',
  used_example: 'You used a concrete example, which made the idea easier to grasp.',
  mastery_gain: 'Your explanation was clear enough for the student to start getting it.',
  accurate_explanation: 'You explained a key idea accurately and to the point.',
};
const IMPROVE: Partial<Record<EvidenceKind, [string, string]>> = {
  incorrect_explanation: ['Part of your explanation didn\'t match the material.', 'Re-check that point in your notes, then explain it again in one or two sentences.'],
  shallow_explanation: ['One explanation said what happens but not why, or skipped an essential part.', 'After stating an idea, add the one-sentence reason it works that way.'],
  misconception_unaddressed: ['The student voiced a wrong idea and still believes it.', 'When the student says something wrong, say clearly why it\'s wrong and what\'s true instead.'],
  demo_failed: ['When the student explained it back, they got it wrong.', 'Correct their explanation right away, then have them try once more.'],
  question_unanswered: ["You didn't answer the student's question.", 'Answer the student\'s question before moving on; if you can\'t, that\'s a gap to review.'],
  open_question: ['The student was still left with a specific question.', 'Before moving on, address what the student is still wondering.'],
  demo_partial: ["The student's explanation back was missing a key part.", 'Fill in the missing piece, then ask them to explain it again.'],
  question_partial: ["You only partly answered the student's question.", 'Answer the exact question asked, in one or two sentences.'],
  undefined_term: ['You used a technical term without explaining it.', 'Define new terms in plain words the first time you use them.'],
  unclear_explanation: ['One explanation was hard for this student to follow.', 'Use a simpler everyday example before the technical version.'],
  misconception_partial: ['You touched on the student\'s wrong idea but didn\'t settle it.', 'State the correct idea directly and say why the wrong one fails.'],
  no_checks: ['You never checked whether the student understood.', 'Ask the student to say it back in their own words at least once.'],
  long_run: ['You talked for a long stretch without letting the student respond.', 'Pause after each key idea and ask a quick question.'],
  slow_response: ['You hesitated a long time before answering a question.', 'Review the part you hesitated on: it may be a gap in your own understanding.'],
  not_covered: ['You didn\'t get to all of the key ideas.', 'Start with the most important idea so it always gets covered.'],
  pace: ['You spoke quickly for this student.', 'Slow down around new ideas and leave short pauses.'],
};

export function fallbackThree(evidence: EvidenceItem[]): ThreeItems {
  const good = pick(evidence.filter((e) => e.positive), STRENGTH_ORDER);
  const bad = pick(evidence.filter((e) => !e.positive), WEAKNESS_ORDER);
  const tpl = bad ? IMPROVE[bad.kind] : null;
  return {
    went_well: good ? { text: WELL[good.kind] || good.label, evidence: good } : null,
    improve: bad && tpl ? { text: tpl[0], evidence: bad } : null,
    try_next: bad && tpl ? { text: tpl[1], evidence: bad } : null,
  };
}

// The app shows timestamps itself; strip any the LLM wrote (they may be wrong).
export function cleanText(t: string): string {
  return String(t || '')
    .replace(/\b(at|around|by)\s+\d{1,2}:\d{2}\s*,?\s*/gi, '')
    .replace(/\(\s*\d{1,2}:\d{2}\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .slice(0, 240);
}

interface RawItem {
  text: string;
  evidence_id: string;
}

// Accept the LLM's three items only if each cites valid evidence of the right
// kind (a strength must cite something that went well, a weakness an issue);
// otherwise use the deterministic choice for that slot.
export function validateThree(raw: { went_well?: RawItem; improve?: RawItem; try_next?: RawItem } | null, evidence: EvidenceItem[]): ThreeItems & { usedFallback: boolean } {
  const byId = new Map(evidence.map((e) => [e.id.toUpperCase(), e]));
  const fb = fallbackThree(evidence);
  let usedFallback = false;
  const take = (item: RawItem | undefined, want: 'positive' | 'negative' | 'any', fallback: FeedbackItem | null): FeedbackItem | null => {
    const e = item ? byId.get(String(item.evidence_id || '').toUpperCase()) : undefined;
    const ok = !!item && !!e && cleanText(item.text) && (want === 'any' || (want === 'positive') === e.positive);
    if (ok) return { text: cleanText(item!.text), evidence: e! };
    usedFallback = true;
    return fallback;
  };
  const improve = take(raw?.improve, 'negative', fb.improve);
  return {
    went_well: take(raw?.went_well, 'positive', fb.went_well),
    improve,
    try_next: improve ? take(raw?.try_next, 'any', fb.try_next) : fb.try_next,
    usedFallback,
  };
}

export function evidenceForPrompt(evidence: EvidenceItem[]): string {
  return evidence
    .map((e) => `${e.id} [${e.at === null ? 'whole session' : fmt(e.at)}] (${e.positive ? 'went well' : 'issue'}) ${e.label}${e.quote ? ` Quote: "${e.quote}"` : ''}`)
    .join('\n');
}
