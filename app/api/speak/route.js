import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { dialogueSystem, dialogueUserText, DIALOGUE_SCHEMA } from '../../../lib/prompts.js';
import { serverError } from '../../../lib/http.js';

// Phrases an intent the app already chose (question type + target) in the
// student's voice. It never chooses what to ask.
export const maxDuration = 30;

export async function POST(req) {
  try {
    const body = await req.json();
    const level = getLevel(body.levelId);
    const out = await callJSON({
      model: MODELS.fast,
      system: dialogueSystem(level),
      content: [{ type: 'text', text: dialogueUserText(body) }],
      schema: DIALOGUE_SCHEMA,
      maxTokens: 200,
    });
    const text = String(out.text || '').trim().replace(/^["“]|["”]$/g, '');
    return NextResponse.json({ text });
  } catch (err) {
    return serverError(err);
  }
}
