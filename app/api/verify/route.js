import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.ts';
import { verifySystem, verifyUserText, VERIFY_SCHEMA } from '../../../lib/prompts.js';
import { badRequest, serverError } from '../../../lib/http.js';
import { recordVerify } from '../../../lib/daily/record.ts';

// Grades a student demonstration (explain-back, new example, or answer)
// against the concept's correct description. The status change itself is
// applied by deterministic rules in lib/student/knowledge.ts.
export const maxDuration = 30;

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body?.concept?.description || !body?.statement?.trim()) return badRequest('Nothing to verify.');
    const out = await callJSON({
      model: MODELS.fast,
      system: verifySystem(getLevel(body.levelId)),
      content: [{ type: 'text', text: verifyUserText(body) }],
      schema: VERIFY_SCHEMA,
      maxTokens: 200,
    });
    const raw = String(out.verdict || '').toLowerCase();
    const verdict = ['demonstrated', 'partial', 'not_demonstrated'].includes(raw) ? raw : 'not_demonstrated';
    if (body.daily) await recordVerify(body.daily, body.concept?.name, body.mode, verdict); // L2T Daily
    return NextResponse.json({ verdict, note: String(out.note || '').trim() });
  } catch (err) {
    return serverError(err);
  }
}
