import { NextResponse } from 'next/server';
import { callJSON, sourcesToBlocks, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.js';
import { gradeSystem, gradeUserText, GRADE_TOOL } from '../../../lib/prompts.js';
import { finalizeGrade, emptyGrade } from '../../../lib/grading.js';
import { badRequest, serverError } from '../../../lib/http.js';

export const maxDuration = 60;

export async function POST(req) {
  try {
    const { sources, levelId, plan, transcript, notes } = await req.json();
    if (!plan?.rubric?.length) return badRequest('Missing session plan.');

    const text = (transcript || '').trim();
    if (!text) return NextResponse.json(emptyGrade(plan));

    const level = getLevel(levelId);
    const raw = await callJSON({
      model: MODELS.smart,
      system: gradeSystem(level),
      content: [...sourcesToBlocks(sources || []), { type: 'text', text: gradeUserText(plan, text, notes) }],
      schema: GRADE_TOOL.input_schema,
      maxTokens: 8000,
    });

    return NextResponse.json(finalizeGrade(raw, plan, text));
  } catch (err) {
    return serverError(err);
  }
}
