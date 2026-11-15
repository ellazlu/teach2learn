import { NextResponse } from 'next/server';
import { callJSON, MODELS } from '../../../lib/claude.js';
import { badRequest, serverError } from '../../../lib/http.js';
import { whiteboardSystem, whiteboardSchema, whiteboardUserText } from '../../../lib/learner/prompts.js';
import { cleanBoard } from '../../../lib/learner/whiteboard.ts';

// Teach to Learn: reads one whiteboard snapshot with a vision-capable model.
// Called only when the user shares the board, pauses after drawing, or ends
// the session (never per stroke). Unclear parts are returned as questions,
// never guessed.
export const maxDuration = 30;

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_B64 = 2_000_000; // ~1.5 MB image

export async function POST(req) {
  try {
    const { image, mediaType = 'image/png', topic = '', concepts = [], recentSpeech = '', id, at = 0, trigger = 'share' } = await req.json();
    if (typeof image !== 'string' || !image || image.length > MAX_B64) return badRequest('A whiteboard image (under 1.5 MB) is required.');
    if (!TYPES.includes(mediaType)) return badRequest('Unsupported image type.');
    const list = (Array.isArray(concepts) ? concepts : []).slice(0, 12).map((c) => ({ id: String(c.id).toLowerCase(), name: String(c.name).slice(0, 80) }));
    const raw = await callJSON({
      model: MODELS.smart,
      system: whiteboardSystem(),
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: whiteboardUserText({ topic, concepts: list, recentSpeech: String(recentSpeech).slice(-500) }) },
      ],
      schema: whiteboardSchema(list.map((c) => c.id)),
      maxTokens: 800,
    });
    return NextResponse.json(cleanBoard(raw, { id: String(id || `w${Date.now()}`), at: Number(at) || 0, trigger: ['share', 'pause', 'end'].includes(trigger) ? trigger : 'share', conceptIds: list.map((c) => c.id) }));
  } catch (err) {
    return serverError(err);
  }
}
