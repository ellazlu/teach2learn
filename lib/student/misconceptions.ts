// Misconception tracking. A misconception only changes status when an
// evaluation explicitly says the teacher corrected (or reinforced) it AND the
// quoted evidence is really in what the teacher said. Merely mentioning the
// related concept never changes it.

import type {
  ExtractedConcept,
  ExtractedMisconception,
  MisconceptionProposal,
  MisconceptionState,
  MisconceptionStatus,
} from './types.ts';

// Mastery of a concept can't rise past these while a misconception about it stands.
export const CAP_ACTIVE = 55;
export const CAP_PARTIAL = 75;

export function selectMisconceptions(
  list: ExtractedMisconception[],
  concepts: ExtractedConcept[],
  count: number
): MisconceptionState[] {
  const ids = new Set(concepts.map((c) => c.id));
  const seen = new Set<string>();
  const out: MisconceptionState[] = [];
  for (const m of list) {
    if (out.length >= count) break;
    if (!ids.has(m.conceptId) || seen.has(m.id) || !m.belief.trim()) continue;
    seen.add(m.id);
    out.push({ ...m, status: 'active', expressed: false, history: [] });
  }
  return out;
}

export function masteryCapFor(conceptId: string, misconceptions: MisconceptionState[]): number {
  let cap = 100;
  for (const m of misconceptions) {
    if (m.conceptId !== conceptId) continue;
    if (m.status === 'active') cap = Math.min(cap, CAP_ACTIVE);
    else if (m.status === 'partially_addressed') cap = Math.min(cap, CAP_PARTIAL);
  }
  return cap;
}

// Pure status transition table.
export function nextMisconceptionStatus(
  current: MisconceptionStatus,
  effect: MisconceptionProposal['effect']
): MisconceptionStatus {
  if (effect === 'reinforced') return 'active';
  if (effect === 'corrected') return 'resolved';
  // partially_corrected
  return current === 'active' ? 'partially_addressed' : current;
}

export function activeMisconceptions(misconceptions: MisconceptionState[]): MisconceptionState[] {
  return misconceptions.filter((m) => m.status !== 'resolved');
}
