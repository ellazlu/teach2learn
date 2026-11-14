import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { dialogueSystem, dialogueUserText, DIALOGUE_SCHEMA } from '../../../lib/prompts.js';
import { specificity, fallbackLine } from '../../../lib/student/dialogue.ts';
import { serverError } from '../../../lib/http.js';

// Phrases an intent the app already chose (question type + target) in the
// student's voice. It never chooses what to ask. Lines must be specific: a
// vague line gets one retry, then a deterministic specific fallback.
export const maxDuration = 30;

const clean = (t) => String(t || '').trim().replace(/^["“]|["”]$/g, '');

export async function POST(req) {
  try {
    const body = await req.json();
    const level = getLevel(body.levelId);
    const anchors = Array.isArray(body.anchors) ? body.anchors : [];
    const ask = async (retryNote) =>
      clean(
        (
          await callJSON({
            model: MODELS.fast,
            system: dialogueSystem(level),
            content: [{ type: 'text', text: dialogueUserText(body, retryNote) }],
            schema: DIALOGUE_SCHEMA,
            maxTokens: 200,
          })
        ).text
      );

    // show_understanding is a paraphrase, not a question: skip the check.
    if (body.intent === 'show_understanding') return NextResponse.json({ text: await ask(''), source: 'llm' });

    let text = await ask('');
    if (specificity(text, anchors).ok) return NextResponse.json({ text, source: 'llm' });

    const target = body.details?.focusQuestion || body.details?.term || body.details?.conceptName || '';
    text = await ask(`Your last attempt ("${text}") was too vague. Ask about exactly this, using these words: ${target}`);
    if (specificity(text, anchors).ok) return NextResponse.json({ text, source: 'retry' });

    return NextResponse.json({ text: fallbackLine(body.intent, body.details || {}), source: 'fallback' });
  } catch (err) {
    return serverError(err);
  }
}
