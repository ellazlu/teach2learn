import { NextResponse } from 'next/server';
import { callJSON, sourcesToBlocks, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { extractionSystem, EXTRACTION_SCHEMA } from '../../../lib/prompts.js';
import { sanitizeExtraction } from '../../../lib/student/knowledge.ts';
import { badRequest, serverError } from '../../../lib/http.js';

// Concept + misconception extraction. Runs in the background as the session
// starts; the student model is initialized from it in the browser.
export const maxDuration = 60;

export async function POST(req) {
  try {
    const { sources = [], topic = '', levelId, focus = '', misconception = '' } = await req.json();
    const fromMaterial = Array.isArray(sources) && sources.length > 0;
    if (!fromMaterial && !topic.trim()) return badRequest('Enter a topic or upload some notes.');

    const level = getLevel(levelId);
    const content = [
      ...sourcesToBlocks(fromMaterial ? sources : []),
      {
        type: 'text',
        text:
          (topic.trim() ? `Topic: ${topic.trim()}\n` : '') +
          (focus.trim() ? `Focus instructions from the user: ${focus.trim()}\n` : '') +
          (String(misconception).trim()
            ? `Practice scenario: the student's first misconception must be this belief (attach it to the concept it belongs to): ${String(misconception).trim().slice(0, 200)}\n`
            : '') +
          `\nExtract the concepts and misconceptions for ${level.who}.`,
      },
    ];
    const raw = await callJSON({
      model: MODELS.smart,
      system: extractionSystem(level, fromMaterial),
      content,
      schema: EXTRACTION_SCHEMA,
      maxTokens: 4000,
    });
    const extraction = sanitizeExtraction(
      {
        topicTitle: raw.topic_title,
        overview: raw.overview,
        concepts: (raw.concepts || []).map((c) => ({ ...c, keyTerms: c.key_terms })),
        misconceptions: (raw.misconceptions || []).map((m) => ({ ...m, conceptId: m.concept_id })),
      },
      fromMaterial
    );
    if (extraction.concepts.length < 2) {
      return badRequest("Couldn't find enough concepts to teach. Try more detailed notes or a clearer topic.");
    }
    return NextResponse.json(extraction);
  } catch (err) {
    return serverError(err);
  }
}
