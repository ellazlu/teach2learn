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
    questionStyle: 'short, concrete questions in everyday words, often comparing to something familiar ("Is that like when…?")',
    voice: { pitch: 1.2, rate: 1.0 },
    params: {
      baseMastery: 8,
      difficultyPenalty: 1.5,
      learnRate: 1.0,
      misconceptionCount: 2,
      minGapSec: 6,
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
    questionStyle: 'thoughtful questions that connect ideas or point out what does not add up ("Wait, if X, then why Y?")',
    voice: { pitch: 1.1, rate: 1.03 },
    params: {
      baseMastery: 22,
      difficultyPenalty: 3.5,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 6,
      confusedBy: 'unexplained_jargon',
      preferredTypes: ['define_term', 'example', 'clarify', 'relate'],
    },
  },
  {
    id: 'high',
    label: 'High schooler',
    emoji: '📚',
    who: 'a 16-year-old high school student',
    understands: 'high-school vocabulary, algebra, definitions, and multi-step cause and effect; they reason carefully and like to know why, not just what',
    lostBy: 'college-level terminology, unexplained acronyms, or skipped steps',
    questionStyle: 'how and why questions, asking for definitions of terms, and how two ideas connect',
    voice: { pitch: 1.0, rate: 1.03 },
    params: {
      baseMastery: 30,
      difficultyPenalty: 5,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 7,
      confusedBy: 'unexplained_jargon',
      preferredTypes: ['relate', 'clarify', 'define_term', 'example'],
    },
  },
  {
    id: 'college',
    label: 'College student',
    emoji: '🎓',
    who: 'an undergraduate taking an intro course in this subject',
    understands: 'intro-level vocabulary in this field, formal definitions, math, and diagrams; they test ideas against what they already know',
    lostBy: 'graduate-level terms, unexplained acronyms, or leaps in reasoning',
    questionStyle: 'questions about mechanisms, precise definitions, and how concepts relate; sometimes restates an idea to check ("So is it that…?")',
    voice: { pitch: 1.0, rate: 1.03 },
    params: {
      baseMastery: 40,
      difficultyPenalty: 6,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 7,
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
    voice: { pitch: 0.95, rate: 1.0 },
    params: {
      baseMastery: 62,
      difficultyPenalty: 4,
      learnRate: 1.2,
      misconceptionCount: 1,
      minGapSec: 8,
      confusedBy: 'vagueness',
      preferredTypes: ['challenge', 'relate', 'clarify', 'prerequisite'],
    },
  },
];

export function getLevel(id: string | null | undefined): Level {
  return LEVELS.find((l) => l.id === id) || LEVELS[1];
}
