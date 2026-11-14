import type { EvaluationProposal, Extraction, Segment } from '../lib/student/types.ts';
import { sanitizeExtraction } from '../lib/student/knowledge.ts';

export const EXTRACTION: Extraction = sanitizeExtraction(
  {
    topicTitle: 'Photosynthesis',
    overview: 'How plants make food from light.',
    concepts: [
      { id: 'c1', name: 'What photosynthesis is', description: 'Plants make sugar from light, water and CO2.', difficulty: 1, prerequisites: [], keyTerms: ['photosynthesis'] },
      { id: 'c2', name: 'Chlorophyll', description: 'Green pigment that absorbs red and blue light.', difficulty: 2, prerequisites: ['c1'], keyTerms: ['chlorophyll'] },
      { id: 'c3', name: 'Light-dependent reactions', description: 'Split water, release oxygen, make ATP and NADPH.', difficulty: 4, prerequisites: ['c1', 'c2'], keyTerms: ['ATP', 'NADPH', 'photolysis'] },
      { id: 'c4', name: 'Calvin cycle', description: 'Fixes CO2 into sugar using ATP and NADPH.', difficulty: 4, prerequisites: ['c3'], keyTerms: ['RuBisCO', 'G3P'] },
    ],
    misconceptions: [
      { id: 'm1', conceptId: 'c1', belief: 'Plants get their food from the soil.', correction: 'Plants make their own food from light, water and carbon dioxide.' },
      { id: 'm2', conceptId: 'c3', belief: 'The oxygen comes from carbon dioxide.', correction: 'The oxygen comes from splitting water.' },
      { id: 'm3', conceptId: 'c2', belief: 'Plants are green because they absorb green light.', correction: 'Chlorophyll reflects green light.' },
    ],
  },
  true
);

let n = 0;
export function seg(text: string, start = 10, speaker: 'teacher' | 'student' = 'teacher'): Segment {
  n += 1;
  return { id: `seg${n}`, speaker, text, start, end: start + 8 };
}

export function proposal(over: Partial<EvaluationProposal> = {}): EvaluationProposal {
  return {
    concepts: [],
    misconceptions: [],
    undefined_terms: [],
    question_response: { quality: 'none', quote: '' },
    checked_understanding: { happened: false, quote: '' },
    ...over,
  };
}

export const GOOD_C1_TEXT =
  'plants make their own food using sunlight water and carbon dioxide from the air, kind of like a kitchen inside the leaf';
export const goodC1 = proposal({
  concepts: [
    { concept_id: 'c1', explained: true, correctness: 'correct', clarity: 'clear', level_fit: 'appropriate', used_example: true, quote: 'plants make their own food using sunlight water and carbon dioxide' },
  ],
});
