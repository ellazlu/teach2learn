import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { evaluationSystem, evaluationSchema, evaluationUserText } from '../../../lib/prompts.js';
import { badRequest, serverError } from '../../../lib/http.js';

// Evaluates ONE stable teacher segment and returns *proposed* observations.
// It does not change any state: the browser applies the proposal through the
// deterministic update engine (lib/student/knowledge.ts).
export const maxDuration = 30;

export async function POST(req) {
  try {
    const { levelId, model, openQuestion, earlierContext, segment } = await req.json();
    if (!segment?.trim() || !model?.concepts?.length) return badRequest('Nothing to evaluate.');
    const level = getLevel(levelId);
    const conceptIds = model.concepts.map((c) => c.id);
    const misconceptionIds = (model.misconceptions || []).map((m) => m.id);

    const raw = await callJSON({
      model: MODELS.fast,
      system: evaluationSystem(level),
      content: [{ type: 'text', text: evaluationUserText({ model, openQuestion, earlierContext, segment }) }],
      schema: evaluationSchema(conceptIds, misconceptionIds),
      maxTokens: 1500,
    });
    const lower = (s) => String(s || '').toLowerCase();
    return NextResponse.json({
      concepts: (raw.concepts || []).map((c) => ({ ...c, concept_id: lower(c.concept_id), correctness: lower(c.correctness), clarity: lower(c.clarity), level_fit: lower(c.level_fit) })),
      misconceptions: (raw.misconceptions || []).map((m) => ({ ...m, misconception_id: lower(m.misconception_id), effect: lower(m.effect) })),
      undefined_terms: raw.undefined_terms || [],
      question_response: { quality: lower(raw.question_response?.quality) || 'none', quote: raw.question_response?.quote || '' },
      checked_understanding: { happened: !!raw.checked_understanding?.happened, quote: raw.checked_understanding?.quote || '' },
    });
  } catch (err) {
    return serverError(err);
  }
}
