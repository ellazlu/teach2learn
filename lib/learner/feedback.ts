// Teach to Learn feedback: about the CONTENT the user explained, never about
// delivery. Four parts: correct understanding, knowledge gaps, misconceptions,
// what to review next. Everything is built from tracked evidence; a language
// model may phrase it, but code checks every citation and falls back to these
// deterministic versions.

import { fmt } from '../student/speech.ts';
import type { Extraction } from '../student/types.ts';
import { understandingNote, understandingOf } from './tracker.ts';
import type { BoardAnalysis, LearnerConcept, LearnerState, Understanding } from './types.ts';

export type StudyEvidenceKind = 'accurate' | 'probe_passed' | 'probe_missed' | 'error' | 'corrected' | 'omission' | 'not_covered' | 'whiteboard';

export interface StudyEvidence {
  id: string; // S1, S2, ...
  kind: StudyEvidenceKind;
  conceptId: string | null;
  at: number | null;
  quote: string;
  detail: string;
  source: 'speech' | 'whiteboard' | null;
}

export function buildStudyEvidence(l: LearnerState, boards: BoardAnalysis[] = []): StudyEvidence[] {
  const out: Omit<StudyEvidence, 'id'>[] = [];
  for (const c of l.concepts) {
    const good = c.explanations.find((e) => e.correctness === 'correct' && e.clarity !== 'unclear');
    if (good) out.push({ kind: 'accurate', conceptId: c.id, at: good.at, quote: good.quote, detail: `accurate explanation of ${c.name}`, source: good.source });
    for (const p of c.probes) {
      if (p.answer === 'full' && p.correct) out.push({ kind: 'probe_passed', conceptId: c.id, at: p.at, quote: p.quote, detail: `answered "${p.text}"`, source: 'speech' });
      else if (p.answer === 'none' || p.answer === 'partial' || p.correct === false) out.push({ kind: 'probe_missed', conceptId: c.id, at: p.at, quote: p.quote, detail: `${p.answer === 'partial' ? 'partly answered' : p.correct === false ? 'answered incorrectly' : 'did not answer'} "${p.text}"`, source: 'speech' });
    }
    for (const e of c.errors) {
      out.push({ kind: e.corrected ? 'corrected' : 'error', conceptId: c.id, at: e.at, quote: e.quote, detail: `${e.kind === 'endorsed_misconception' ? 'agreed with a wrong idea about' : 'inaccurate statement about'} ${c.name}${e.corrected ? ' (corrected later)' : ''}`, source: e.source });
    }
    for (const o of c.omissions) out.push({ kind: 'omission', conceptId: c.id, at: o.at, quote: o.quote, detail: `left open: ${o.question}`, source: 'speech' });
    if (c.coverage === 'not_covered') out.push({ kind: 'not_covered', conceptId: c.id, at: null, quote: '', detail: `${c.name} was not covered`, source: null });
  }
  for (const b of boards) {
    if (b.blank) continue;
    out.push({ kind: 'whiteboard', conceptId: b.conceptIds[0] || null, at: b.at, quote: (b.transcription || b.description).slice(0, 140), detail: 'whiteboard', source: 'whiteboard' });
  }
  out.sort((a, b) => (a.at ?? 1e9) - (b.at ?? 1e9));
  return out.map((e, i) => ({ ...e, id: `S${i + 1}` }));
}

// ---- What to review next ------------------------------------------------------------

export interface ReviewCandidate {
  conceptId: string;
  name: string;
  score: number;
  why: string;
}

// Ranked by how much the gap matters, earlier (foundational) concepts first.
// `recurring` (concept names missed in earlier sessions) adds weight.
export function reviewCandidates(l: LearnerState, ext: Extraction | null, recurring: string[] = []): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  const n = l.concepts.length;
  const dependents = (id: string) => (ext?.concepts || []).filter((c) => c.prerequisites.includes(id)).map((c) => l.concepts.find((x) => x.id === c.id)).filter(Boolean) as LearnerConcept[];
  l.concepts.forEach((c, i) => {
    const u = understandingOf(c);
    if (u === 'demonstrated') return;
    const order = (n - i) / n; // earlier = more foundational
    const errs = c.errors.filter((e) => !e.corrected);
    const builtOn = dependents(c.id).filter((d) => d.coverage !== 'not_covered');
    const rec = recurring.some((r) => r.toLowerCase() === c.name.toLowerCase());
    let score = order;
    let why: string;
    if (errs.length) {
      score += 4;
      why = 'what you said about it was inaccurate and stayed uncorrected';
    } else if (builtOn.length && u === 'not_verified') {
      score += 3;
      why = `${builtOn[0].name} builds on it, but it wasn't explained`;
    } else if (c.coverage === 'discussed') {
      score += c.probes.some((p) => p.answer === 'partial' || p.answer === 'none' || p.correct === false) ? 2.2 : 1.6;
      why = understandingNote(c).replace(/\.$/, '').toLowerCase();
    } else {
      score += 1.4;
      why = 'it was not covered';
    }
    if (rec) {
      score += 1;
      why += '; it was also a gap in an earlier session';
    }
    out.push({ conceptId: c.id, name: c.name, score: Math.round(score * 100) / 100, why });
  });
  return out.sort((a, b) => b.score - a.score);
}

// ---- Feedback ------------------------------------------------------------------------

export interface StudyFeedback {
  concepts: { id: string; name: string; understanding: Understanding; note: string }[];
  correct: { text: string; evidenceIds: string[] };
  gaps: { text: string; evidenceIds: string[] };
  misconceptions: { evidenceId: string; conceptId: string | null; name: string; quote: string; at: number | null; source: string | null; note: string }[];
  reviewNext: { conceptId: string; name: string; text: string } | null;
  usedFallback: boolean;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function fallbackStudyFeedback(l: LearnerState, ev: StudyEvidence[], ext: Extraction | null, recurring: string[] = []): StudyFeedback {
  const name = (id: string | null) => l.concepts.find((c) => c.id === id)?.name || '';
  const concepts = l.concepts.map((c) => ({ id: c.id, name: c.name, understanding: understandingOf(c), note: understandingNote(c) }));

  const accurate = ev.filter((e) => e.kind === 'accurate');
  const passed = ev.filter((e) => e.kind === 'probe_passed');
  const correctNames = [...new Set(accurate.map((e) => name(e.conceptId)))];
  const passedNames = [...new Set(passed.map((e) => name(e.conceptId)))];
  const correct = correctNames.length
    ? {
        text: `You explained ${list(correctNames.slice(0, 3))} accurately${passedNames.length ? `, and handled a follow-up question on ${list(passedNames.slice(0, 2))}` : ''}.`,
        evidenceIds: [...accurate.slice(0, 3), ...passed.slice(0, 2)].map((e) => e.id),
      }
    : { text: 'Nothing was explained accurately enough to count yet.', evidenceIds: [] };

  const notCovered = ev.filter((e) => e.kind === 'not_covered');
  const omissions = ev.filter((e) => e.kind === 'omission' && concepts.find((c) => c.id === e.conceptId)?.understanding !== 'demonstrated');
  const missed = ev.filter((e) => e.kind === 'probe_missed');
  const parts: string[] = [];
  if (notCovered.length) parts.push(`Not covered: ${list(notCovered.slice(0, 4).map((e) => name(e.conceptId)))}.`);
  if (omissions.length) parts.push(`Left open on ${name(omissions[omissions.length - 1].conceptId)}: ${omissions[omissions.length - 1].detail.replace(/^left open: /, '')}`);
  else if (missed.length) parts.push(`On ${name(missed[missed.length - 1].conceptId)}, you ${missed[missed.length - 1].detail}.`);
  const gaps = parts.length
    ? { text: parts.join(' '), evidenceIds: [...notCovered.slice(0, 4), ...omissions.slice(-1), ...(omissions.length ? [] : missed.slice(-1))].map((e) => e.id) }
    : { text: 'No major gaps on the checklist.', evidenceIds: [] };

  const misconceptions = ev
    .filter((e) => e.kind === 'error')
    .slice(0, 3)
    .map((e) => {
      const c = ext?.concepts.find((x) => x.id === e.conceptId);
      const hint = c?.description && !c.description.startsWith('(Added by') ? ` Check it against: ${c.description}` : ' Check this against your notes.';
      return { evidenceId: e.id, conceptId: e.conceptId, name: name(e.conceptId), quote: e.quote, at: e.at, source: e.source, note: `This doesn't match how ${name(e.conceptId)} works.${hint}`.slice(0, 220) };
    });

  const top = reviewCandidates(l, ext, recurring)[0];
  const reviewNext = top ? { conceptId: top.conceptId, name: top.name, text: `Review ${top.name}: ${top.why}.` } : null;
  return { concepts, correct, gaps, misconceptions, reviewNext, usedFallback: true };
}

// Check a model-written version against the evidence; keep only what holds up.
export function validateStudyFeedback(
  raw: any,
  base: StudyFeedback,
  ev: StudyEvidence[],
  candidates: ReviewCandidate[],
): StudyFeedback {
  if (!raw || typeof raw !== 'object') return base;
  const ids = new Map(ev.map((e) => [e.id, e]));
  const clean = (s: unknown, max = 260) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const okIds = (xs: unknown, kinds: string[]) => (Array.isArray(xs) ? xs.map(String).filter((x) => kinds.includes(ids.get(x)?.kind || '')) : []);
  const out: StudyFeedback = { ...base, usedFallback: false };

  const cIds = okIds(raw.correct?.evidence_ids, ['accurate', 'probe_passed', 'whiteboard']);
  if (clean(raw.correct?.text) && (cIds.length || !base.correct.evidenceIds.length)) out.correct = { text: clean(raw.correct.text), evidenceIds: cIds };
  else out.usedFallback = true;

  const gIds = okIds(raw.gaps?.evidence_ids, ['not_covered', 'omission', 'probe_missed']);
  if (clean(raw.gaps?.text) && (gIds.length || !base.gaps.evidenceIds.length)) out.gaps = { text: clean(raw.gaps.text), evidenceIds: gIds };
  else out.usedFallback = true;

  const notes = new Map<string, string>();
  for (const m of Array.isArray(raw.misconceptions) ? raw.misconceptions : []) {
    if (ids.get(String(m?.evidence_id))?.kind === 'error' && clean(m?.what_was_off)) notes.set(String(m.evidence_id), clean(m.what_was_off, 200));
  }
  out.misconceptions = base.misconceptions.map((m) => (notes.has(m.evidenceId) ? { ...m, note: notes.get(m.evidenceId)! } : m));

  const top3 = candidates.slice(0, 3);
  const pick = top3.find((c) => c.conceptId === String(raw.review_next?.concept_id || '').toLowerCase());
  if (pick && clean(raw.review_next?.text)) out.reviewNext = { conceptId: pick.conceptId, name: pick.name, text: clean(raw.review_next.text, 220) };
  else out.usedFallback = true;
  return out;
}

export function studyEvidenceForPrompt(ev: StudyEvidence[], l: LearnerState): string {
  const name = (id: string | null) => l.concepts.find((c) => c.id === id)?.name || '-';
  return ev
    .map((e) => `${e.id} [${e.kind}] ${e.at !== null ? fmt(e.at) + ' ' : ''}${name(e.conceptId)}: ${e.detail}${e.quote ? ` | "${e.quote}"` : ''}${e.source === 'whiteboard' ? ' (whiteboard)' : ''}`)
    .join('\n');
}
