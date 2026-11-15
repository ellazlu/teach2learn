// L2T Daily: everyone teaches the same subject each day. The challenge for a
// date is fixed by a date-based schedule (UTC), and each challenge carries a
// fixed concept list and student misconceptions, so every attempt starts from
// the same student knowledge and is scored on the same objectives.

import type { Extraction, LevelId } from '../student/types.ts';

export interface DailyChallenge {
  id: string;
  topic: string;
  levelId: LevelId;
  timeLimitSec: number;
  objectives: string[]; // shown to everyone; match the extraction's concepts
  extraction: Extraction;
}

type C = [id: string, name: string, description: string, difficulty: number, prerequisites: string[], keyTerms: string[]];
type M = [id: string, conceptId: string, belief: string, correction: string];

function challenge(id: string, topic: string, levelId: LevelId, overview: string, concepts: C[], misconceptions: M[]): DailyChallenge {
  return {
    id,
    topic,
    levelId,
    timeLimitSec: 120,
    objectives: concepts.map((c) => c[1]),
    extraction: {
      topicTitle: topic,
      overview,
      fromMaterial: false,
      concepts: concepts.map(([cid, name, description, difficulty, prerequisites, keyTerms]) => ({ id: cid, name, description, difficulty, prerequisites, keyTerms })),
      misconceptions: misconceptions.map(([mid, conceptId, belief, correction]) => ({ id: mid, conceptId, belief, correction })),
    },
  };
}

export const DAILY_CHALLENGES: DailyChallenge[] = [
  challenge('photosynthesis', 'Photosynthesis', 'middle', 'How plants make their own food from light.', [
    ['c1', 'Plants make their own food', 'Plants make sugar (glucose) from carbon dioxide and water using energy from light.', 1, [], ['photosynthesis', 'glucose', 'sugar']],
    ['c2', 'Role of chlorophyll', 'Chlorophyll in chloroplasts absorbs light energy (mostly red and blue) that powers the process.', 2, ['c1'], ['chlorophyll', 'chloroplast']],
    ['c3', 'Where the oxygen comes from', 'The oxygen released comes from splitting water molecules, not from carbon dioxide.', 3, ['c1'], ['oxygen', 'water']],
  ], [
    ['m1', 'c1', 'Plants get their food from the soil.', 'Soil gives water and minerals; the plant makes its own food from CO2 and water using light.'],
    ['m2', 'c3', 'The oxygen plants give off comes from carbon dioxide.', 'The released oxygen comes from water that is split during the light reactions.'],
  ]),
  challenge('seasons', 'Why we have seasons', 'middle', 'What really causes summer and winter.', [
    ['c1', 'Earth\'s axial tilt', 'Earth\'s axis is tilted about 23.5 degrees and stays pointed the same way as Earth orbits the Sun.', 1, [], ['tilt', 'axis']],
    ['c2', 'Angle of sunlight', 'When a hemisphere tilts toward the Sun, sunlight hits it more directly, concentrating energy on a smaller area.', 2, ['c1'], ['direct sunlight', 'angle']],
    ['c3', 'Length of day', 'The hemisphere tilted toward the Sun has longer days, so it is heated for more hours.', 2, ['c1'], ['daylight', 'day length']],
  ], [
    ['m1', 'c1', 'It\'s summer when Earth is closest to the Sun.', 'Distance barely changes; Earth is actually closest to the Sun in January. Tilt causes seasons.'],
    ['m2', 'c2', 'Both hemispheres have summer at the same time.', 'When the north tilts toward the Sun it is summer there and winter in the south.'],
  ]),
  challenge('inertia', 'Newton\'s first law', 'high', 'Why objects keep doing what they are doing.', [
    ['c1', 'Inertia', 'An object stays at rest or keeps moving in a straight line at constant speed unless a net force acts on it.', 2, [], ['inertia', 'first law']],
    ['c2', 'Net force', 'Only an unbalanced (net) force changes motion; balanced forces leave velocity unchanged.', 2, ['c1'], ['net force', 'balanced forces']],
    ['c3', 'Friction explains slowing down', 'Moving things on Earth slow down because friction and air resistance act on them, not because motion "runs out".', 3, ['c2'], ['friction', 'air resistance']],
  ], [
    ['m1', 'c1', 'A moving object needs a force to keep moving.', 'No force is needed to keep moving at constant velocity; a force is needed to change velocity.'],
    ['m2', 'c3', 'Things naturally slow down and stop on their own.', 'They slow down because forces like friction act on them.'],
  ]),
  challenge('supply-demand', 'Supply and demand', 'high', 'How markets set prices.', [
    ['c1', 'Law of demand', 'As price rises, the quantity people want to buy falls (and vice versa), other things equal.', 1, [], ['demand', 'quantity demanded']],
    ['c2', 'Law of supply', 'As price rises, producers are willing to sell more because it is more profitable.', 1, [], ['supply', 'quantity supplied']],
    ['c3', 'Equilibrium price', 'The market price settles where quantity demanded equals quantity supplied; shortages push prices up and surpluses push them down.', 3, ['c1', 'c2'], ['equilibrium', 'shortage', 'surplus']],
  ], [
    ['m1', 'c3', 'Sellers can set any price they want.', 'If the price is above equilibrium, unsold surplus pushes it down; competition limits prices.'],
    ['m2', 'c1', 'If the price goes up, demand goes down, so the demand curve shifts left.', 'A price change moves along the demand curve; a shift needs a change in something other than price.'],
  ]),
  challenge('vaccines', 'How vaccines work', 'high', 'How vaccines train the immune system.', [
    ['c1', 'Antigens and the immune response', 'The immune system recognizes specific molecules (antigens) on a pathogen and makes antibodies against them.', 2, [], ['antigen', 'antibody', 'immune system']],
    ['c2', 'What a vaccine contains', 'A vaccine exposes the body to a harmless form or part of a pathogen (or instructions to make it) so the immune system can respond without the disease.', 2, ['c1'], ['vaccine', 'weakened', 'mRNA']],
    ['c3', 'Immune memory', 'Memory cells remain after the first response, so a later infection is fought off faster and more strongly.', 3, ['c1'], ['memory cells', 'immunity']],
  ], [
    ['m1', 'c2', 'Vaccines give you a mild case of the disease.', 'Most vaccines contain no live, disease-causing pathogen; they train immunity without causing the illness.'],
    ['m2', 'c3', 'Vaccines work by fighting the virus directly.', 'Vaccines train your immune system ahead of time; your own immune cells fight the virus later.'],
  ]),
  challenge('water-cycle', 'The water cycle', 'middle', 'How water moves between land, sea and sky.', [
    ['c1', 'Evaporation', 'Heat from the Sun turns liquid water into water vapor that rises into the air.', 1, [], ['evaporation', 'water vapor']],
    ['c2', 'Condensation and clouds', 'As vapor rises and cools it condenses into tiny droplets that form clouds.', 2, ['c1'], ['condensation', 'clouds']],
    ['c3', 'Precipitation and collection', 'Droplets combine and fall as rain or snow, collecting in oceans, lakes and groundwater, and the cycle repeats.', 2, ['c2'], ['precipitation', 'groundwater']],
  ], [
    ['m1', 'c2', 'Clouds are made of water vapor.', 'Clouds are tiny liquid droplets or ice crystals; water vapor itself is invisible.'],
    ['m2', 'c1', 'Water only evaporates when it boils.', 'Evaporation happens at any temperature, just faster when warmer.'],
  ]),
  challenge('natural-selection', 'Natural selection', 'high', 'How populations change over generations.', [
    ['c1', 'Variation', 'Individuals in a population differ in inherited traits because of genetic variation.', 1, [], ['variation', 'traits', 'genes']],
    ['c2', 'Differential survival and reproduction', 'Individuals with traits better suited to the environment tend to survive and reproduce more.', 2, ['c1'], ['survival', 'reproduction', 'fitness']],
    ['c3', 'Change over generations', 'Helpful inherited traits become more common in the population over many generations.', 3, ['c2'], ['evolution', 'generations', 'adaptation']],
  ], [
    ['m1', 'c3', 'Animals change their traits because they need to.', 'Individuals don\'t choose or develop new inherited traits; existing variation is selected over generations.'],
    ['m2', 'c2', 'Survival of the fittest means the strongest survive.', '"Fit" means best suited to reproduce in that environment, not strongest.'],
  ]),
  challenge('compound-interest', 'Compound interest', 'high', 'Why savings grow faster over time.', [
    ['c1', 'Simple vs. compound interest', 'Simple interest is paid only on the original amount; compound interest is also paid on interest already earned.', 1, [], ['interest', 'principal']],
    ['c2', 'Exponential growth', 'Compounding makes money grow by the same percentage each period, so the amount added gets larger every period.', 2, ['c1'], ['exponential', 'growth']],
    ['c3', 'Effect of time', 'Because growth builds on itself, starting earlier matters a lot: doubling the time more than doubles the interest.', 3, ['c2'], ['time', 'doubling']],
  ], [
    ['m1', 'c2', 'Compound interest adds the same amount every year.', 'It adds the same percentage, so the amount added grows each year.'],
    ['m2', 'c3', 'Waiting a few years to start saving doesn\'t matter much.', 'Lost early years cost the most because later growth builds on them.'],
  ]),
];

const DAY_MS = 86_400_000;

// The day key is the UTC date, so everyone shares the same day and reset time.
export const dayKey = (now: number = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const dayIndex = (key: string) => Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY_MS);

export function challengeFor(key: string): DailyChallenge {
  const n = DAILY_CHALLENGES.length;
  return DAILY_CHALLENGES[((dayIndex(key) % n) + n) % n];
}

export function nextResetAt(now: number = Date.now()): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

// Public view (the full concept descriptions stay server-side for scoring, but
// the student's starting knowledge is part of the shared challenge).
export function publicChallenge(key: string) {
  const c = challengeFor(key);
  return { day: key, id: c.id, topic: c.topic, levelId: c.levelId, timeLimitSec: c.timeLimitSec, objectives: c.objectives, extraction: c.extraction };
}
