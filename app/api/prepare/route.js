import { NextResponse } from 'next/server';
import { callJSON, sourcesToBlocks, MODELS } from '../../../lib/claude.js';
import { getLevel } from '../../../lib/levels.js';
import { prepSystem, PREP_TOOL } from '../../../lib/prompts.js';
import { verifyPlan } from '../../../lib/verify.js';
import { badRequest, serverError } from '../../../lib/http.js';

export const maxDuration = 60;

export async function POST(req) {
  try {
    const { sources, levelId, focus } = await req.json();
    if (!Array.isArray(sources) || sources.length === 0) {
      return badRequest('Add at least one file or some pasted text.');
    }
    const level = getLevel(levelId);
    const content = [
      ...sourcesToBlocks(sources),
      {
        type: 'text',
        text:
          `Source names: ${sources.map((s) => `"${s.name}"`).join(', ')}\n` +
          (focus?.trim() ? `Focus instructions from the student: ${focus.trim()}\n` : '') +
          `\nBuild the session plan for ${level.who} from the source material above.`,
      },
    ];

    const raw = await callJSON({
      model: MODELS.smart,
      system: prepSystem(level),
      content,
      schema: PREP_TOOL.input_schema,
      maxTokens: 6000,
    });

    const plan = verifyPlan(raw, sources);
    if (plan.rubric.length === 0) {
      return badRequest("Couldn't build a rubric from this material. Try adding more detailed notes or a clearer file.");
    }
    return NextResponse.json(plan);
  } catch (err) {
    return serverError(err);
  }
}
