import { NextResponse } from 'next/server';
import { callJSON, sourcesToBlocks, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { extractionSystem, EXTRACTION_SCHEMA } from '../../../lib/prompts.js';
import { sanitizeExtraction } from '../../../lib/student/knowledge.ts';
import { badRequest, serverError } from '../../../lib/http.js';
import { studyExtractionSystem, outlineSystem, OUTLINE_SCHEMA, detailsSystem, DETAILS_SCHEMA, detailsUserText } from '../../../lib/learner/prompts.js';
import { cleanStudyExtraction, outlineToExtraction, cleanDetails } from '../../../lib/learner/checklist.ts';

// Concept + misconception extraction. Runs in the background as the session
// starts; the student model is initialized from it in the browser.
export const maxDuration = 60;

export async function POST(req) {
  try {
    const { sources = [], topic = '', levelId, focus = '', misconception = '', mode = 'educator', stage = '', outline = null } = await req.json();
    const study = mode === 'student'; // Teach to Learn: a 5-10 concept checklist
    const fromMaterial = Array.isArray(sources) && sources.length > 0;
    if (!fromMaterial && !topic.trim()) return badRequest('Enter a topic or upload some notes.');

    const level = getLevel(levelId);
    const notes =
      (topic.trim() ? `Topic: ${topic.trim()}\n` : '') +
      (focus.trim() ? `Focus instructions from the user: ${focus.trim()}\n` : '') +
      (String(misconception).trim() ? `Practice scenario: the student's first misconception must be this belief (attach it to the concept it belongs to): ${String(misconception).trim().slice(0, 200)}\n` : '');

    // Checklist, stage 1 (both modes): short names only, on the fast model, so
    // the checklist shows up in a few seconds.
    if (stage === 'outline') {
      const raw = await callJSON({
        model: MODELS.fast,
        system: outlineSystem(level, fromMaterial),
        content: [...sourcesToBlocks(fromMaterial ? sources : []), { type: 'text', text: `${notes}\nList the concepts.` }],
        schema: OUTLINE_SCHEMA,
        maxTokens: 700,
      });
      const ext = outlineToExtraction(raw, fromMaterial);
      if (ext.concepts.length < 2) return badRequest("Couldn't find enough concepts. Try more detailed notes or a clearer topic.");
      return NextResponse.json(ext);
    }
    // Stage 2: hidden details for those exact concepts, on the smart model,
    // while the user reviews the checklist.
    if (stage === 'details') {
      const list = (outline?.concepts || []).slice(0, 12).map((c) => ({ id: String(c.id).toLowerCase(), name: String(c.name).slice(0, 80) }));
      if (!list.length) return badRequest('The concept list is missing.');
      const raw = await callJSON({
        model: MODELS.smart,
        system: detailsSystem(level, fromMaterial),
        content: [...sourcesToBlocks(fromMaterial ? sources : []), { type: 'text', text: `${notes}${detailsUserText({ topicTitle: outline.topicTitle || topic, concepts: list })}` }],
        schema: DETAILS_SCHEMA,
        maxTokens: 2500,
      });
      return NextResponse.json(cleanDetails(raw, list.map((c) => c.id)));
    }
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
          (study ? `\nBuild the concept checklist (5-10 concepts) for explaining this to ${level.who}.` : `\nExtract the concepts and misconceptions for ${level.who}.`),
      },
    ];
    const raw = await callJSON({
      model: MODELS.smart,
      system: study ? studyExtractionSystem(level, fromMaterial) : extractionSystem(level, fromMaterial),
      content,
      schema: EXTRACTION_SCHEMA,
      maxTokens: 4000,
    });
    const extraction = (study ? cleanStudyExtraction : sanitizeExtraction)(
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
