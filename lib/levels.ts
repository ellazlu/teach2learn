// The five learner levels. `who` / `understands` / `lostBy` / `questionStyle`
// are fed into prompts; `params` drive the deterministic student model.

import type { LevelId, QuestionType } from './student/types.ts';

export interface LevelParams {
  baseMastery: number; // starting mastery for an easy concept with no prerequisites
  difficultyPenalty: number; // mastery lost per difficulty step above 1
  learnRate: number; // multiplier on mastery gains
  misconceptionCount: number; // misconceptions the student starts with
  minGapSec: number; // minimum seconds between the student's turns (answers to the teacher are exempt)
  confusedBy: 'any_jargon' | 'unexplained_jargon' | 'advanced_jargon' | 'vagueness';
  preferredTypes: QuestionType[]; // question styles typical for this level, in order
}

export interface Level {
  id: LevelId;
  label: string;
  emoji: string;
  who: string;
  understands: string;
  lostBy: string;
  knows: string; // vocabulary and prerequisites this learner already has (never "undefined")
  questionStyle: string;
  voice: { pitch: number; rate: number };
  params: LevelParams;
}

export const LEVELS: Level[] = [
  {
    id: 'kindergarten',
    label: 'Kindergartner',
    emoji: '🧸',
    who: 'a 5-year-old kindergartner',
    understands: 'everyday words, simple cause and effect, and things they can see, touch, or imagine; they are bright and curious and learn quickly from concrete examples',
    lostBy: 'technical words, numbers or formulas, and abstract ideas that are not tied to something familiar',
    knows: 'everyday words and ideas: sun, water, air, plants, animals, food, grow, hot and cold, bigger and smaller, counting, push and pull',
    questionStyle: 'short, concrete questions in everyday words, often comparing to something familiar ("Is that like when…?")',
    voice: { pitch: 1.2, rate: 1.0 },
    params: {
      baseMastery: 12,
      difficultyPenalty: 1.5,
      learnRate: 1.0,
      misconceptionCount: 2,
      minGapSec: 10,
      confusedBy: 'any_jargon',
      preferredTypes: ['define_term', 'example', 'clarify', 'curiosity'],
    },
  },
  {
    id: 'middle',
    label: 'Middle schooler',
    emoji: '🎒',
    who: 'a 12-year-old middle schooler',
    understands: 'school-level science and math vocabulary, step-by-step processes, and analogies; they reason logically, connect ideas, notice when something does not add up, and learn quickly from a clear explanation',
    lostBy: 'specialized jargon, equations, or multi-step reasoning that is not walked through',
    knows: 'everything taught through grade 6: cells, energy, atoms and molecules, oxygen and carbon dioxide, gravity, force, mass, the solar system, food chains, fractions, decimals, percentages, ratios, basic equations, maps and graphs',
    questionStyle: 'thoughtful questions that connect ideas or point out what does not add up ("Wait, if X, then why Y?")',
    voice: { pitch: 1.1, rate: 1.03 },
    params: {
      baseMastery: 30,
      difficultyPenalty: 3.5,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 10,
      confusedBy: 'unexplained_jargon',
      preferredTypes: ['define_term', 'example', 'clarify', 'relate'],
    },
  },
  {
    id: 'high',
    label: 'High schooler',
    emoji: '📚',
    who: 'a 16-year-old high school student',
    understands: 'high-school vocabulary, algebra, functions, definitions, and multi-step cause and effect; they have taken biology, chemistry and physics, reason carefully, and like to know why, not just what',
    lostBy: 'college-level terminology, unexplained acronyms, or skipped steps',
    knows: 'everything a good middle schooler knows plus standard high-school terms: atom, molecule, element, compound, chemical reaction, photosynthesis, respiration, DNA, protein, enzyme, cell membrane, velocity, acceleration, momentum, energy conservation, variables, functions, linear and quadratic equations, exponents, basic statistics',
    questionStyle: 'how and why questions, asking for definitions of terms, and how two ideas connect',
    voice: { pitch: 1.0, rate: 1.03 },
    params: {
      baseMastery: 42,
      difficultyPenalty: 4,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 12,
      confusedBy: 'unexplained_jargon',
      preferredTypes: ['relate', 'clarify', 'define_term', 'example'],
    },
  },
  {
    id: 'college',
    label: 'College student',
    emoji: '🎓',
    who: 'an undergraduate taking an intro course in this subject',
    understands: 'intro-level vocabulary in this field plus everything a strong high-school graduate knows, formal definitions, calculus-level math, and diagrams; they test ideas against what they already know',
    lostBy: 'graduate-level terms, unexplained acronyms, or leaps in reasoning',
    knows: 'all standard high-school science and math (including terms like ATP, mitochondria, chloroplast, ion, pH, covalent bond, derivative, integral, vector, kinetic and potential energy, probability) plus first-year college vocabulary in this subject',
    questionStyle: 'questions about mechanisms, precise definitions, and how concepts relate; sometimes restates an idea to check ("So is it that…?")',
    voice: { pitch: 1.0, rate: 1.03 },
    params: {
      baseMastery: 55,
      difficultyPenalty: 4.5,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 12,
      confusedBy: 'advanced_jargon',
      preferredTypes: ['relate', 'clarify', 'challenge', 'prerequisite'],
    },
  },
  {
    id: 'expert',
    label: 'Expert',
    emoji: '🔬',
    who: 'a professional who works in this field',
    understands: 'the full technical vocabulary of the field, nuance, edge cases, and precise definitions',
    lostBy: 'vague, imprecise, or hand-wavy claims',
    knows: 'the field\'s complete technical vocabulary and standard results',
    questionStyle: 'probing questions about precision, conditions, exceptions, and edge cases; politely challenges vague claims',
    voice: { pitch: 0.95, rate: 1.0 },
    params: {
      baseMastery: 70,
      difficultyPenalty: 4,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 14,
      confusedBy: 'vagueness',
      preferredTypes: ['challenge', 'relate', 'clarify', 'prerequisite'],
    },
  },
];

export function getLevel(id: string | null | undefined): Level {
  return LEVELS.find((l) => l.id === id) || LEVELS[1];
}

// Words this level already knows (from `knows`, plus every younger level's).
// A term on this list is never treated as unexplained jargon.
export function knownTerms(id: string): Set<string> {
  const upTo = LEVELS.slice(0, LEVELS.findIndex((l) => l.id === getLevel(id).id) + 1);
  const out = new Set<string>();
  for (const l of upTo) {
    for (const part of l.knows.toLowerCase().split(/[,:;()]| and | plus /)) {
      const t = part.replace(/^(including terms like|everything[^,]*|standard high-school terms|all standard[^,]*|the field's[^,]*)/, '').trim();
      if (t && t.split(' ').length <= 3) out.add(t);
    }
  }
  return out;
}

export function isKnownTerm(term: string, levelId: string): boolean {
  const t = term.toLowerCase().trim();
  const known = knownTerms(levelId);
  return known.has(t) || known.has(t.replace(/s$/, '')) || known.has(`${t}s`);
}
