// The five learner levels. `who` / `understands` / `lostBy` / `questionStyle`
// are fed into prompts; `params` drive the deterministic student model.

import type { LevelId, QuestionType } from './student/types.ts';

export interface LevelParams {
  baseMastery: number; // starting mastery for an easy concept with no prerequisites
  difficultyPenalty: number; // mastery lost per difficulty step above 1
  learnRate: number; // multiplier on mastery gains
  misconceptionCount: number; // misconceptions the student starts with
  minGapSec: number; // minimum seconds between the student's interjections
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
    understands: 'everyday words, simple cause and effect, and things they can see, touch, or imagine',
    lostBy: 'technical words, numbers or formulas, and abstract ideas that are not tied to something familiar',
    questionStyle: 'very short questions in everyday words, like "Why?", "What does that word mean?", or "Is that like when…?"',
    voice: { pitch: 1.6, rate: 1.0 },
    params: {
      baseMastery: 8,
      difficultyPenalty: 1.5,
      learnRate: 0.8,
      misconceptionCount: 3,
      minGapSec: 22,
      confusedBy: 'any_jargon',
      preferredTypes: ['define_term', 'example', 'clarify', 'curiosity'],
    },
  },
  {
    id: 'middle',
    label: 'Middle schooler',
    emoji: '🎒',
    who: 'a 12-year-old middle schooler',
    understands: 'basic school vocabulary, simple diagrams, step-by-step processes, and everyday analogies',
    lostBy: 'specialized jargon, equations, or multi-step reasoning that is not walked through',
    questionStyle: 'simple clarifying questions: what a word means, asking for an example, or how one step leads to the next',
    voice: { pitch: 1.3, rate: 1.05 },
    params: {
      baseMastery: 18,
      difficultyPenalty: 3.5,
      learnRate: 0.9,
      misconceptionCount: 3,
      minGapSec: 25,
      confusedBy: 'unexplained_jargon',
      preferredTypes: ['define_term', 'example', 'clarify', 'relate'],
    },
  },
  {
    id: 'high',
    label: 'High schooler',
    emoji: '📚',
    who: 'a 16-year-old high school student',
    understands: 'standard high-school vocabulary, basic algebra, definitions, and cause-and-effect chains',
    lostBy: 'college-level terminology, unexplained acronyms, or skipped steps',
    questionStyle: 'how and why questions, asking for definitions of terms, and how two ideas connect',
    voice: { pitch: 1.1, rate: 1.05 },
    params: {
      baseMastery: 28,
      difficultyPenalty: 5,
      learnRate: 1.0,
      misconceptionCount: 2,
      minGapSec: 28,
      confusedBy: 'unexplained_jargon',
      preferredTypes: ['relate', 'clarify', 'define_term', 'example'],
    },
  },
  {
    id: 'college',
    label: 'College student',
    emoji: '🎓',
    who: 'an undergraduate taking an intro course in this subject',
    understands: 'intro-level vocabulary in this field, formal definitions, and simple math and diagrams',
    lostBy: 'graduate-level terms, unexplained acronyms, or leaps in reasoning',
    questionStyle: 'questions about mechanisms, precise definitions, and how concepts relate; sometimes restates an idea to check ("So is it that…?")',
    voice: { pitch: 1.0, rate: 1.05 },
    params: {
      baseMastery: 40,
      difficultyPenalty: 6,
      learnRate: 1.05,
      misconceptionCount: 2,
      minGapSec: 30,
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
    questionStyle: 'probing questions about precision, conditions, exceptions, and edge cases; politely challenges vague claims',
    voice: { pitch: 0.9, rate: 1.05 },
    params: {
      baseMastery: 62,
      difficultyPenalty: 4,
      learnRate: 1.1,
      misconceptionCount: 1,
      minGapSec: 32,
      confusedBy: 'vagueness',
      preferredTypes: ['challenge', 'relate', 'clarify', 'prerequisite'],
    },
  },
];

export function getLevel(id: string | null | undefined): Level {
  return LEVELS.find((l) => l.id === id) || LEVELS[1];
}
