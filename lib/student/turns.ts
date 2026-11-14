// Turn-taking. The student replies at natural end-of-turn pauses (not after a
// word count), to what the teacher JUST said. All decisions here are
// deterministic; the reply LLM only phrases the chosen action.

import type { StudentModel, TeacherQuestionKind, TurnAction } from './types.ts';
import { getLevel } from '../levels.ts';
import { normalize } from '../verify.ts';
import { selectQuestion } from './questions.ts';
import { wordCount } from './segments.ts';
import { contentWords } from './dialogue.ts';

export const END_OF_TURN_SEC = 0.8; // silence after a final result that ends the teacher's turn
export const MIN_TURN_WORDS = 6; // shorter turns ("um, so…") don't get a reply
export const ACK_MIN_WORDS = 35; // a brief "got it" only after a substantial explanation
export const ACK_PROBABILITY = 0.45;
export const MAX_DEMO_ATTEMPTS = 2;

const CHECK = [
  /\b(does|did) (that|this|it) make sense\b/,
  /\bmakes? sense\b$/,
  /\bdo you (understand|get it|get that|follow)\b/,
  /\b(you|are you) (following|with me)\b/,
  /\bany questions\b/,
  /\bis that clear\b/,
  /\b(got it|okay so far|clear so far)$/,
];
const CONTENT = [
  /\bwhat do you think\b/,
  /\bcan you (tell me|explain|guess|think of|remember|name)\b/,
  /\bdo you (know|remember) (what|why|how|where|which|who)\b/,
  /\bwhy do you think\b/,
  /\bhow (would|could|do) you\b/,
  /\bwhat (would|will) happen\b/,
  /\bwhat happens (if|when)\b/,
  /\bwhat (is|are|does|do) (a|an|the)?\s?\w+$/,
  /\b(any|have you) (idea|ideas|guesses?)\b/,
];

// Did the teacher just ask the student something? Looks at the end of the turn
// only, so rhetorical questions the teacher answers themselves don't count.
export function detectTeacherQuestion(turnText: string): TeacherQuestionKind {
  const raw = turnText.trim();
  const words = normalize(raw).split(' ');
  const tail = words.slice(-14).join(' ');
  if (CHECK.some((re) => re.test(tail))) return 'check';
  if (CONTENT.some((re) => re.test(tail))) return 'content';
  if (/\?\s*$/.test(raw)) return 'content';
  return null;
}

// Which concepts the teacher's words are about, immediately, without waiting
// for the background evaluation. A key term or the concept's name counts;
// otherwise the concept(s) sharing the most content words with its description
// (at least two, or a single unambiguous one).
export function matchConcepts(text: string, model: StudentModel): string[] {
  const t = ` ${normalize(text)} `;
  const said = contentWords(text);
  const hits = new Set<string>();
  const overlaps = new Map<string, number>();
  for (const c of model.concepts) {
    const termHit = [c.name, ...c.keyTerms].some((term) => {
      const n = normalize(term);
      if (n.length < 3) return false;
      const singular = n.endsWith('s') ? n.slice(0, -1) : n;
      return t.includes(` ${n} `) || t.includes(` ${singular} `) || t.includes(` ${singular}s `);
    });
    if (termHit) hits.add(c.id);
    let overlap = 0;
    for (const w of contentWords(`${c.name} ${c.description}`)) if (said.has(w)) overlap++;
    overlaps.set(c.id, overlap);
  }
  const best = Math.max(0, ...overlaps.values());
  const leaders = [...overlaps].filter(([, n]) => n === best).map(([id]) => id);
  if (best >= 2 || (best === 1 && leaders.length === 1)) leaders.forEach((id) => hits.add(id));
  return model.concepts.filter((c) => hits.has(c.id)).map((c) => c.id);
}

export interface TurnContext {
  model: StudentModel;
  turnText: string; // what the teacher said since the student last spoke
  now: number; // teaching seconds
  timeLimitSec: number;
  lastStudentAt: number; // -Infinity if never
  lastStudentWasQuestion: boolean;
  recentConceptIds: string[]; // from background evaluations
  demoAttempts: Record<string, number>;
  rng: () => number;
}

// Pick the concept the student should try to show it understands.
function demoCandidate(ctx: TurnContext, prefer: string[]): { conceptId: string; mode: 'explain_back' | 'apply' } | null {
  const ids = [...prefer, ...ctx.recentConceptIds, ...ctx.model.concepts.map((c) => c.id)];
  for (const id of [...new Set(ids)]) {
    const c = ctx.model.concepts.find((x) => x.id === id);
    if (!c || !c.explained || (c.verification || 'not_verified') === 'demonstrated') continue;
    const attempts = ctx.demoAttempts[id] || 0;
    if (attempts >= MAX_DEMO_ATTEMPTS) continue;
    const stuck = (c.openGaps || []).length > 0 || ctx.model.misconceptions.some((m) => m.conceptId === id && m.status === 'active' && m.expressed);
    if (stuck) continue; // it would ask about what it's stuck on first
    return { conceptId: id, mode: attempts === 0 && c.verification !== 'partial' ? 'explain_back' : 'apply' };
  }
  return null;
}

export function decideTurn(ctx: TurnContext): TurnAction {
  const { model } = ctx;
  const level = getLevel(model.levelId);
  const words = wordCount(ctx.turnText);
  const matched = matchConcepts(ctx.turnText, model);
  const asked = detectTeacherQuestion(ctx.turnText);

  // 1) The teacher asked the student something: always answer.
  if (asked) {
    if (asked === 'check') {
      const demo = demoCandidate(ctx, matched);
      if (demo) return { kind: 'demonstrate', ...demo, reason: 'teacher checked understanding: explain it back' };
    }
    return { kind: 'answer', questionKind: asked, conceptIds: matched.length ? matched : ctx.recentConceptIds.slice(0, 1), reason: `teacher asked a ${asked} question` };
  }

  if (words < MIN_TURN_WORDS) return { kind: 'none', reason: 'teacher is still getting going' };

  // 2) The teacher just responded to the student's question: react to the answer.
  if (ctx.lastStudentWasQuestion) {
    return { kind: 'acknowledge', conceptId: matched[0] ?? null, reason: 'reacting to the answer to its question' };
  }

  // 3) Near the end, show understanding (explain back / apply to a new example).
  const demoDue = ctx.now >= Math.max(40, ctx.timeLimitSec * 0.55);
  if (demoDue) {
    const demo = demoCandidate(ctx, matched);
    if (demo) return { kind: 'demonstrate', ...demo, reason: 'time to show what it learned' };
  }

  // 4) Don't talk too often.
  if (ctx.now - ctx.lastStudentAt < level.params.minGapSec) return { kind: 'none', reason: 'letting the teacher continue' };

  // 5) A real question about a real gap.
  const plan = selectQuestion(model, { recentConceptIds: [...new Set([...matched, ...ctx.recentConceptIds])], latestConceptIds: matched, rng: ctx.rng });
  if (plan) return { kind: 'ask', plan, reason: `${plan.type}: ${plan.reason}` };

  // 6) Otherwise sometimes just acknowledge and let them continue.
  if (words >= ACK_MIN_WORDS && matched.length && ctx.rng() < ACK_PROBABILITY) {
    return { kind: 'acknowledge', conceptId: matched[0], reason: 'following along' };
  }
  return { kind: 'none', reason: 'following along quietly' };
}
