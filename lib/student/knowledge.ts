// The student knowledge model and its deterministic update engine.
//
// The LLM looks at one stable teacher segment and *proposes* judgments
// (EvaluationProposal). applyEvaluation() decides what those judgments do to
// the model. It never trusts a proposal whose quote isn't in the segment, never
// raises mastery for a mere mention, never processes the same segment twice,
// and never touches state when the proposal is missing.

import type {
  ConceptState,
  Evidence,
  EvaluationProposal,
  Extraction,
  ExtractedConcept,
  KnowledgeEvent,
  LevelFit,
  LevelId,
  Segment,
  StudentModel,
} from './types.ts';
import { getLevel, type Level } from '../levels.ts';
import { normalize, quoteAppearsIn } from '../verify.ts';
import { masteryCapFor, nextMisconceptionStatus, selectMisconceptions } from './misconceptions.ts';

export const MAX_GAIN = 28; // mastery points for a perfect explanation of an unknown concept
const MAX_CONCEPTS = 10;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// Deterministic value in [-range, range] so concepts of equal difficulty
// don't all start at exactly the same mastery.
export function stableJitter(key: string, range: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 1000) / 999) * 2 * range - range;
}

// ---- Extraction cleanup --------------------------------------------------------

export function sanitizeExtraction(raw: Partial<Extraction> | null | undefined, fromMaterial: boolean): Extraction {
  const seen = new Set<string>();
  const concepts: ExtractedConcept[] = [];
  for (const c of raw?.concepts || []) {
    const id = String(c?.id || '').trim().toLowerCase();
    if (!id || seen.has(id) || !String(c?.name || '').trim()) continue;
    seen.add(id);
    concepts.push({
      id,
      name: String(c.name).trim(),
      description: String(c.description || '').trim(),
      difficulty: Number.isFinite(Number(c.difficulty)) ? clamp(Math.round(Number(c.difficulty)), 1, 5) : 2,
      prerequisites: (c.prerequisites || []).map((p) => String(p).trim().toLowerCase()),
      keyTerms: (c.keyTerms || []).map((t) => String(t).trim()).filter(Boolean),
    });
    if (concepts.length >= MAX_CONCEPTS) break;
  }
  // Prerequisites must point at an *earlier* concept: this drops unknown ids,
  // self-references, and cycles in one rule.
  concepts.forEach((c, i) => {
    const earlier = new Set(concepts.slice(0, i).map((x) => x.id));
    c.prerequisites = [...new Set(c.prerequisites)].filter((p) => earlier.has(p));
  });
  const misconceptions = (raw?.misconceptions || [])
    .map((m) => ({
      id: String(m?.id || '').trim().toLowerCase(),
      conceptId: String(m?.conceptId || '').trim().toLowerCase(),
      belief: String(m?.belief || '').trim(),
      correction: String(m?.correction || '').trim(),
    }))
    .filter((m) => m.id && seen.has(m.conceptId) && m.belief);
  return {
    topicTitle: String(raw?.topicTitle || 'Your topic').trim(),
    overview: String(raw?.overview || '').trim(),
    fromMaterial,
    concepts,
    misconceptions,
  };
}

// ---- Initial state -----------------------------------------------------------------

export function initialMastery(concept: ExtractedConcept, level: Level): number {
  const p = level.params;
  let m = p.baseMastery - (concept.difficulty - 1) * p.difficultyPenalty;
  m -= Math.min(3, concept.prerequisites.length) * 4; // builds on other ideas
  m += stableJitter(`${concept.id}|${concept.name}`, 3);
  return Math.round(clamp(m, 0, 95));
}

export function initStudentModel(extraction: Extraction, levelId: LevelId): StudentModel {
  const level = getLevel(levelId);
  const concepts: ConceptState[] = extraction.concepts.map((c) => {
    const m = initialMastery(c, level);
    return {
      ...c,
      initialMastery: m,
      mastery: m,
      confidence: 0.3,
      mentioned: false,
      explained: false,
      explainCount: 0,
      evidence: [],
      openGaps: [],
    };
  });
  const misconceptions = selectMisconceptions(extraction.misconceptions, extraction.concepts, level.params.misconceptionCount);
  // A misconception means the student can't already be confident about that concept.
  for (const c of concepts) {
    const cap = masteryCapFor(c.id, misconceptions);
    if (c.mastery > cap) c.mastery = c.initialMastery = cap;
  }
  return {
    version: 1,
    levelId: level.id,
    concepts,
    misconceptions,
    behavior: 'listening',
    behaviorSince: 0,
    questions: [],
    processedSegmentIds: [],
    undefinedTerms: [],
  };
}

// Used when concept extraction never finished: feedback still works from speech evidence.
export function emptyModel(levelId: LevelId): StudentModel {
  return initStudentModel({ topicTitle: '', overview: '', fromMaterial: false, concepts: [], misconceptions: [] }, levelId);
}

// ---- Update engine --------------------------------------------------------------

const CORRECTNESS_WEIGHT = { correct: 1, partially_correct: 0.45, incorrect: 0 } as const;
const CLARITY_WEIGHT = { clear: 1, somewhat_clear: 0.55, unclear: 0.12 } as const;
const LEVEL_ORDER: LevelId[] = ['kindergarten', 'middle', 'high', 'college', 'expert'];

export function levelFitFactor(fit: LevelFit, levelId: LevelId): number {
  const i = LEVEL_ORDER.indexOf(levelId); // 0..4
  if (fit === 'too_advanced') return [0.2, 0.35, 0.5, 0.65, 0.9][i];
  if (fit === 'too_simple') return [0.95, 0.9, 0.85, 0.65, 0.4][i];
  return 1;
}

// How much the prerequisites hold back learning: 1 when all are well understood.
export function prerequisiteFactor(concept: ConceptState, model: StudentModel): number {
  if (!concept.prerequisites.length) return 1;
  const ms = concept.prerequisites
    .map((id) => model.concepts.find((c) => c.id === id)?.mastery)
    .filter((m): m is number => typeof m === 'number');
  if (!ms.length) return 1;
  return 0.45 + 0.55 * Math.min(1, Math.min(...ms) / 50);
}

const MAX_GAPS = 3;

// Record a specific sticking point (deduplicated, newest last).
function openGap(c: ConceptState, question: string, quote: string, segmentId: string, at: number): boolean {
  const q = String(question || '').trim().slice(0, 160);
  if (!q) return false;
  const gaps = (c.openGaps || []).filter((g) => normalize(g.question) !== normalize(q));
  c.openGaps = [...gaps, { question: q, quote, segmentId, at }].slice(-MAX_GAPS);
  return true;
}

export interface ApplyResult {
  model: StudentModel;
  events: KnowledgeEvent[];
}

export function applyEvaluation(
  model: StudentModel,
  segment: Segment | null | undefined,
  proposal: EvaluationProposal | null | undefined
): ApplyResult {
  // Only stable teacher speech is ever evaluated; failures leave state untouched.
  if (!segment || segment.speaker !== 'teacher' || !proposal) return { model, events: [] };
  if (model.processedSegmentIds.includes(segment.id)) return { model, events: [] };

  const level = getLevel(model.levelId);
  const next: StudentModel = structuredClone(model);
  next.processedSegmentIds = [...next.processedSegmentIds, segment.id].slice(-500);
  const events: KnowledgeEvent[] = [];
  const at = segment.start;
  const sid = segment.id;
  const real = (q: string | undefined) => !!q && quoteAppearsIn(q, segment.text);
  const reject = (detail: string) => events.push({ type: 'rejected_proposal', segmentId: sid, at, detail });
  const addEvidence = (c: ConceptState, e: Evidence) => {
    c.evidence = [...c.evidence, e].slice(-12);
  };

  // 1) Misconceptions first, so a correction in this segment can lift the mastery cap.
  const seenMis = new Set<string>();
  for (const p of proposal.misconceptions || []) {
    const id = String(p.misconception_id || '').toLowerCase();
    const m = next.misconceptions.find((x) => x.id === id);
    if (!m || seenMis.has(id)) continue;
    seenMis.add(id);
    if (!real(p.quote)) {
      reject(`misconception ${id}: quote not found in segment`);
      continue;
    }
    const to = nextMisconceptionStatus(m.status, p.effect);
    if (to === m.status) continue;
    const change = { segmentId: sid, at, from: m.status, to, quote: p.quote };
    m.history = [...m.history, change];
    m.status = to;
    events.push({ type: 'misconception_change', misconceptionId: m.id, ...change });
    if (to === 'resolved') {
      const c = next.concepts.find((x) => x.id === m.conceptId);
      if (c) {
        const from = c.mastery;
        c.mastery = Math.round(clamp(c.mastery + 6, 0, masteryCapFor(c.id, next.misconceptions)));
        if (c.mastery !== from) {
          events.push({ type: 'mastery_change', segmentId: sid, at, conceptId: c.id, from, to: c.mastery, quote: p.quote, reason: 'misconception resolved' });
          addEvidence(c, { segmentId: sid, at, quote: p.quote, note: 'misconception resolved', delta: c.mastery - from });
        }
      }
    }
  }

  // 2) Concepts.
  const seenConcepts = new Set<string>();
  for (const p of proposal.concepts || []) {
    const id = String(p.concept_id || '').toLowerCase();
    const c = next.concepts.find((x) => x.id === id);
    if (!c || seenConcepts.has(id)) continue;
    seenConcepts.add(id);
    if (!real(p.quote)) {
      reject(`concept ${id}: quote not found in segment`);
      continue;
    }
    c.mentioned = true;
    c.openGaps = c.openGaps || [];

    if (!p.explained) {
      openGap(c, p.gap, p.quote, sid, at);
      c.confidence = clamp(c.confidence + 0.02, 0, 0.95);
      events.push({ type: 'mentioned_only', segmentId: sid, at, conceptId: id, quote: p.quote });
      continue;
    }

    if (p.correctness === 'incorrect') {
      const from = c.mastery;
      c.mastery = Math.round(clamp(c.mastery - Math.min(8, c.mastery * 0.15)));
      c.confidence = clamp(c.confidence + 0.05, 0, 0.95);
      events.push({ type: 'incorrect_explanation', segmentId: sid, at, conceptId: id, quote: p.quote });
      if (c.mastery !== from) {
        events.push({ type: 'mastery_change', segmentId: sid, at, conceptId: id, from, to: c.mastery, quote: p.quote, reason: 'incorrect explanation' });
      }
      addEvidence(c, { segmentId: sid, at, quote: p.quote, note: 'incorrect explanation', delta: c.mastery - from });
      continue;
    }

    const fit = levelFitFactor(p.level_fit, level.id);
    const example = p.used_example ? (['kindergarten', 'middle', 'high'].includes(level.id) ? 1.15 : 1.05) : 1;
    const quality = CORRECTNESS_WEIGHT[p.correctness] * CLARITY_WEIGHT[p.clarity] * fit * example;
    // A clear, correct, well-pitched explanation closes the student's open
    // questions about this concept; anything less can open a specific one.
    const landed = p.correctness === 'correct' && p.clarity === 'clear' && fit >= 0.6;
    if (landed) c.openGaps = [];
    else openGap(c, p.gap, p.quote, sid, at);
    if (p.clarity === 'unclear' || fit < 0.6) {
      events.push({ type: 'unclear_explanation', segmentId: sid, at, conceptId: id, quote: p.quote, levelFit: p.level_fit, gap: String(p.gap || '').trim() });
    }
    if (p.used_example) events.push({ type: 'used_example', segmentId: sid, at, conceptId: id, quote: p.quote });

    const gain = MAX_GAIN * quality * prerequisiteFactor(c, next) * level.params.learnRate * ((100 - c.mastery) / 100);
    const cap = masteryCapFor(c.id, next.misconceptions);
    const from = c.mastery;
    if (c.mastery < cap) c.mastery = Math.round(Math.min(cap, c.mastery + gain));
    if (quality >= 0.4) {
      c.explained = true;
      c.explainCount += 1;
    }
    c.confidence = clamp(c.confidence + 0.03 + 0.12 * quality, 0, 0.95);
    const note =
      c.mastery === from && from >= cap ? 'held back by a misconception' : quality >= 0.7 ? 'clear explanation' : 'weak explanation';
    addEvidence(c, { segmentId: sid, at, quote: p.quote, note, delta: c.mastery - from });
    if (c.mastery !== from) {
      events.push({ type: 'mastery_change', segmentId: sid, at, conceptId: id, from, to: c.mastery, quote: p.quote, reason: note });
    }
  }

  // 3) Jargon the student heard without a definition.
  for (const t of proposal.undefined_terms || []) {
    const term = String(t.term || '').trim();
    if (!term || !real(t.quote) || !quoteAppearsIn(term, segment.text, 1)) continue;
    if (next.undefinedTerms.some((x) => x.toLowerCase() === term.toLowerCase())) continue;
    next.undefinedTerms = [...next.undefinedTerms, term];
    events.push({ type: 'undefined_term', segmentId: sid, at, term, quote: t.quote });
  }

  // 4) Did this segment answer the student's open question?
  const q = [...next.questions].reverse().find((x) => x.status === 'pending' || x.status === 'partially_answered');
  if (q && q.at <= segment.end) {
    const r = proposal.question_response;
    const quality = r && real(r.quote) ? r.quality : 'none';
    const before = q.status;
    if (quality === 'full') {
      q.status = 'answered';
      q.answerQuote = r.quote;
      const c = next.concepts.find((x) => x.id === q.conceptId);
      if (c) c.openGaps = []; // the question about it was answered
    } else if (quality === 'partial') {
      q.status = 'partially_answered';
      q.answerQuote = r.quote;
    } else {
      q.segmentsSinceAsked += 1;
      if (q.segmentsSinceAsked >= 3 && q.status === 'pending') q.status = 'unanswered';
    }
    if (q.status !== before) {
      events.push({ type: 'question_status', segmentId: sid, at, questionId: q.id, status: q.status, quote: q.answerQuote });
    }
  }

  // 5) Did the teacher check for understanding?
  const chk = proposal.checked_understanding;
  if (chk?.happened && real(chk.quote)) events.push({ type: 'checked_understanding', segmentId: sid, at, quote: chk.quote });

  return { model: next, events };
}

// ---- Summaries --------------------------------------------------------------------

export interface LearningSummary {
  learned: { conceptId: string; name: string; from: number; to: number }[];
  stillConfusing: { conceptId: string; name: string; mastery: number; why: string }[];
  notCovered: { conceptId: string; name: string }[];
  misconceptions: { id: string; belief: string; from: string; to: string }[];
}

export function learningSummary(initial: StudentModel, final: StudentModel): LearningSummary {
  const learned = final.concepts
    .map((c) => ({ conceptId: c.id, name: c.name, from: initial.concepts.find((x) => x.id === c.id)?.mastery ?? c.initialMastery, to: c.mastery }))
    .filter((x) => x.to - x.from >= 8)
    .sort((a, b) => b.to - b.from - (a.to - a.from));
  const activeOn = new Set(final.misconceptions.filter((m) => m.status !== 'resolved').map((m) => m.conceptId));
  const stillConfusing = final.concepts
    .filter((c) => c.mentioned && (c.mastery < 45 || activeOn.has(c.id)))
    .map((c) => ({
      conceptId: c.id,
      name: c.name,
      mastery: c.mastery,
      why: activeOn.has(c.id) ? 'still holds a misconception' : c.explained ? 'explanation did not fully land' : 'mentioned but never explained',
    }));
  const notCovered = final.concepts.filter((c) => !c.mentioned).map((c) => ({ conceptId: c.id, name: c.name }));
  const misconceptions = final.misconceptions.map((m) => ({
    id: m.id,
    belief: m.belief,
    from: initial.misconceptions.find((x) => x.id === m.id)?.status || 'active',
    to: m.status,
  }));
  return { learned, stillConfusing, notCovered, misconceptions };
}

// Compact view of the model for prompts (keeps tokens and latency down).
export function modelForPrompt(model: StudentModel) {
  return {
    concepts: model.concepts.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      key_terms: c.keyTerms,
      student_mastery: c.mastery,
      explained_so_far: c.explained,
    })),
    misconceptions: model.misconceptions.map((m) => ({ id: m.id, concept_id: m.conceptId, belief: m.belief, correction: m.correction, status: m.status })),
  };
}
