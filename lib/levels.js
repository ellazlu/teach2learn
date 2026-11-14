// The five learner levels. These descriptions are fed straight into the prompts,
// so editing them changes how the learner listens and how strict the rubric is.

export const LEVELS = [
  {
    id: 'kindergarten',
    label: 'Kindergartner',
    emoji: '🧸',
    who: 'a 5-year-old kindergartner',
    understands: 'everyday words, simple cause and effect, and things they can see, touch, or imagine',
    lostBy: 'technical words, numbers or formulas, and abstract ideas that are not tied to something familiar',
    depth: 'Only the one to three biggest ideas, in the simplest possible terms. No vocabulary requirements unless a word can be explained simply.',
    rubricCount: '3-5',
  },
  {
    id: 'middle',
    label: 'Middle schooler',
    emoji: '🎒',
    who: 'a 12-year-old middle schooler',
    understands: 'basic school vocabulary, simple diagrams, step-by-step processes, and everyday analogies',
    lostBy: 'specialized jargon, equations, or multi-step reasoning that is not walked through',
    depth: 'The main ideas and how they connect, plus the few most important terms with simple definitions.',
    rubricCount: '4-7',
  },
  {
    id: 'high',
    label: 'High schooler',
    emoji: '📚',
    who: 'a 16-year-old high school student',
    understands: 'standard high-school vocabulary, basic algebra, definitions, and cause-and-effect chains',
    lostBy: 'college-level terminology, unexplained acronyms, or skipped steps',
    depth: 'The main ideas with their mechanisms, the key terms with definitions, and the most important relationships between them.',
    rubricCount: '5-9',
  },
  {
    id: 'college',
    label: 'College student',
    emoji: '🎓',
    who: 'an undergraduate taking an intro course in this subject',
    understands: 'intro-level vocabulary in this field, formal definitions, and simple math and diagrams',
    lostBy: 'graduate-level terms, unexplained acronyms, or leaps in reasoning',
    depth: 'All major concepts with precise definitions, mechanisms, and how they relate, including important details and conditions.',
    rubricCount: '6-12',
  },
  {
    id: 'expert',
    label: 'Expert',
    emoji: '🔬',
    who: 'a professional who works in this field',
    understands: 'the full technical vocabulary of the field, nuance, edge cases, and precise definitions',
    lostBy: 'vague, imprecise, or hand-wavy claims (record these as unclear)',
    depth: 'Everything in the material at full precision: exact definitions, mechanisms, conditions, exceptions, and relationships.',
    rubricCount: '8-15',
  },
];

export function getLevel(id) {
  return LEVELS.find((l) => l.id === id) || LEVELS[1];
}
